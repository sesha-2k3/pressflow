import { useCallback, useEffect, useState } from "react";
import "./App.css";

const API = import.meta.env.VITE_API_URL;
const CUSTOMERS = ["alice", "bob"];
const PARTNERS = ["press-delhi", "press-mexico"];

const OPS_STAGES = [
  { status: "AWAITING_PROOF", label: "Awaiting proof", empty: "No orders are waiting for a proof. Place an order to see it here." },
  { status: "IN_PROOF", label: "In proof", empty: "No proofs are out with customers right now." },
  { status: "APPROVED", label: "Approved", empty: "No approved orders are waiting for a partner." },
  { status: "SENT_TO_PARTNER", label: "Sent to partner", empty: "No jobs are waiting for a partner to accept." },
  { status: "ON_PRESS", label: "On press", empty: "Nothing is on press right now." },
];
const ORDER_STEPS = [...OPS_STAGES, { status: "DELIVERED", label: "Delivered" }];

const STATUS_LABELS = {
  ...Object.fromEntries(ORDER_STEPS.map(({ status, label }) => [status, label])),
  AWAITING_APPROVAL: "Awaiting approval",
  SUPERSEDED: "Superseded",
};

// Lists come from GSIs, which are eventually consistent, so they are read again shortly after each change.
const INDEX_SETTLE_MS = 1200;
const TOAST_MS = 4500;

async function request(path, { method = "GET", body, customerId, partnerId } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-customer-id": customerId,
      "x-partner-id": partnerId,
    },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `Request failed with status ${res.status}`);
  return data;
}

function describeError(error) {
  if (error instanceof TypeError) {
    return "Can't reach the API. Check VITE_API_URL in .env and the API's CORS settings.";
  }
  return error.message;
}

const toDateInput = (date) =>
  [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");

function daysFromToday(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toDateInput(date);
}

const formatQuantity = (quantity) => Number(quantity).toLocaleString();
const formatDue = (isoDate) =>
  new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const formatMoment = (isoTimestamp) =>
  new Date(isoTimestamp).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function validateOrderForm({ product, quantity, neededBy }) {
  if (!product.trim()) return "Say what you need printed.";
  if (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0) return "Enter a whole-number quantity above zero.";
  if (!neededBy) return "Choose a date you need it by.";
  return null;
}

export default function App() {
  const [customerId, setCustomerId] = useState(CUSTOMERS[0]);
  const [partnerId, setPartnerId] = useState(PARTNERS[0]);
  const [stage, setStage] = useState(OPS_STAGES[0].status);
  const [orders, setOrders] = useState([]);
  const [queues, setQueues] = useState({});
  const [jobs, setJobs] = useState([]);
  const [openOrderId, setOpenOrderId] = useState(null);
  const [orderPage, setOrderPage] = useState(null);
  const [form, setForm] = useState({ quantity: 5000, product: "Product labels", neededBy: daysFromToday(21) });
  const [busyAction, setBusyAction] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);

  const api = useCallback(
    (path, options) => request(path, { ...options, customerId, partnerId }),
    [customerId, partnerId],
  );
  const post = (path, body) => api(path, { method: "POST", body });

  const showToast = useCallback((kind, text, action) => setToast({ kind, text, action, id: Date.now() }), []);

  const refresh = useCallback(async () => {
    try {
      const [myOrders, stageLists, partnerJobs, page] = await Promise.all([
        api("/orders"),
        Promise.all(OPS_STAGES.map(({ status }) => api(`/ops/queue?status=${status}`))),
        api("/partner/jobs"),
        openOrderId ? api(`/orders/${openOrderId}`) : null,
      ]);
      setOrders(myOrders);
      setQueues(Object.fromEntries(OPS_STAGES.map(({ status }, i) => [status, stageLists[i]])));
      setJobs(partnerJobs);
      setOrderPage(page);
    } catch (error) {
      showToast("error", describeError(error));
    } finally {
      setLoading(false);
    }
  }, [api, openOrderId, showToast]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  async function perform(key, action, toastFor) {
    setBusyAction(key);
    try {
      const result = await action();
      const { text, action: toastAction } = toastFor(result);
      showToast("success", text, toastAction);
      await refresh();
      setTimeout(refresh, INDEX_SETTLE_MS);
    } catch (error) {
      showToast("error", describeError(error));
    } finally {
      setBusyAction(null);
    }
  }

  function switchCustomer(nextCustomerId) {
    setCustomerId(nextCustomerId);
    setOpenOrderId(null);
    setOrderPage(null);
  }

  const formError = validateOrderForm(form);

  function placeOrder(event) {
    event.preventDefault();
    if (formError) return;
    perform(
      "place",
      () => post("/orders", { ...form, product: form.product.trim(), quantity: Number(form.quantity) }),
      (order) => ({
        text: `Order ${order.orderId} placed.`,
        action: { label: "View order", run: () => setOpenOrderId(order.orderId) },
      }),
    );
  }

  function uploadProof(order) {
    const version = order.currentProofVersion + 1;
    perform(
      `proof-${order.orderId}`,
      // DEMO: a made-up file key and checksum stand in for a real S3 upload.
      () => post(`/ops/orders/${order.orderId}/proofs`, {
        fileKey: `artwork/${order.orderId}/v${version}.pdf`,
        checksum: `demo-${crypto.randomUUID().slice(0, 8)}`,
      }),
      () => ({
        text: `Version ${version} uploaded for ${order.orderId}.`,
        action: stage !== "IN_PROOF" && { label: "Show in proof", run: () => setStage("IN_PROOF") },
      }),
    );
  }

  function approveProof(orderId, version) {
    perform(
      `approve-${orderId}`,
      () => post(`/orders/${orderId}/proofs/${version}/approve`),
      () => ({ text: `Version ${version} approved. It's ready to send to a partner.` }),
    );
  }

  function sendToPartner(order) {
    perform(
      `assign-${order.orderId}`,
      () => post(`/ops/orders/${order.orderId}/assign`, { partnerId }),
      () => ({
        text: `${order.orderId} sent to ${partnerId}.`,
        action: { label: "Show sent jobs", run: () => setStage("SENT_TO_PARTNER") },
      }),
    );
  }

  function acceptJob(job) {
    perform(
      `accept-${job.orderId}`,
      () => post(`/partner/jobs/${job.orderId}/accept`),
      () => ({ text: `Job accepted. ${job.orderId} is on press.` }),
    );
  }

  function markDelivered(order) {
    perform(
      `deliver-${order.orderId}`,
      () => post(`/ops/orders/${order.orderId}/deliver`),
      () => ({ text: `${order.orderId} delivered. It has left the active queues.` }),
    );
  }

  const openOrder = orderPage?.order.orderId === openOrderId ? orderPage : null;
  const stageInfo = OPS_STAGES.find(({ status }) => status === stage);
  const stageOrders = queues[stage] ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          PressFlow
        </div>
        <p className="topbar-note">Print orders from brief to doorstep</p>
      </header>

      <form className="brief" onSubmit={placeOrder} aria-label="Place an order">
        <h1 className="brief-prompt">What do you need printed?</h1>
          <p className="brief-sentence">
            Print{" "}
          <input
            className="blank blank-quantity"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            aria-label="Quantity"
            value={form.quantity}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })}
          />{" "}
          <input
            className="blank blank-product"
            type="text"
            maxLength={120}
            aria-label="Product"
            value={form.product}
            onChange={(e) => setForm({ ...form, product: e.target.value })}
          />{" "}
          by{" "}
          <input
            className="blank blank-date"
            type="date"
            min={daysFromToday(0)}
            aria-label="Needed by"
            value={form.neededBy}
            onChange={(e) => setForm({ ...form, neededBy: e.target.value })}
          />
          .
        </p>
        <p className="brief-hint">Click the blue words to change them.</p>
        <div className="brief-actions">
          <label className="inline-field">
            Ordering as
            <select className="inline-select" value={customerId} onChange={(e) => switchCustomer(e.target.value)}>
              {CUSTOMERS.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <button className="btn btn-primary btn-large" type="submit" disabled={Boolean(formError) || busyAction === "place"}>
            {busyAction === "place" ? "Placing order…" : "Place order"}
          </button>
          {formError && <p className="field-hint" role="status">{formError}</p>}
        </div>
      </form>

      <main className="workspace">
        <section className="panel" aria-labelledby="orders-heading">
          <div className="panel-head">
            <h2 id="orders-heading">Your orders</h2>
            <span className="count">{orders.length}</span>
          </div>

          {orders.length === 0 ? (
            <p className="empty">{loading ? "Loading orders…" : "No orders yet. Describe a job above to place your first one."}</p>
          ) : (
            <ul className="rows">
              {orders.map((order) => (
                <li key={order.orderId}>
                  <button
                    type="button"
                    className={`row row-button${order.orderId === openOrderId ? " is-selected" : ""}`}
                    aria-expanded={order.orderId === openOrderId}
                    onClick={() => setOpenOrderId(order.orderId === openOrderId ? null : order.orderId)}
                  >
                    <span>
                      <span className="row-title">{formatQuantity(order.quantity)} × {order.product}</span>
                      <span className="row-meta">{order.orderId}, due {formatDue(order.neededBy)}</span>
                    </span>
                    <StatusPill status={order.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {openOrderId && (
            <OrderDetail
              page={openOrder}
              busy={busyAction === `approve-${openOrderId}`}
              onApprove={approveProof}
              onClose={() => setOpenOrderId(null)}
            />
          )}
        </section>

        <div className="side">
          <section className="panel" aria-labelledby="ops-heading">
            <div className="panel-head">
              <h2 id="ops-heading">Operations</h2>
            </div>
            <div className="tabs" role="tablist" aria-label="Order stage">
              {OPS_STAGES.map(({ status, label }) => (
                <button
                  key={status}
                  type="button"
                  role="tab"
                  className="tab"
                  aria-selected={stage === status}
                  onClick={() => setStage(status)}
                >
                  {label}
                  <span className="tab-count">{queues[status]?.length ?? 0}</span>
                </button>
              ))}
            </div>

            {stageOrders.length === 0 ? (
              <p className="empty">{loading ? "Loading queue…" : stageInfo.empty}</p>
            ) : (
              <ul className="rows" role="tabpanel">
                {stageOrders.map((order) => (
                  <li key={order.orderId} className="row">
                    <span>
                      <span className="row-title">{formatQuantity(order.quantity)} × {order.product}</span>
                      <span className="row-meta">
                        {order.orderId} for {order.customerId}, due {formatDue(order.neededBy)}
                      </span>
                    </span>
                    <OpsAction
                      order={order}
                      partnerId={partnerId}
                      busyAction={busyAction}
                      onUploadProof={uploadProof}
                      onSendToPartner={sendToPartner}
                      onMarkDelivered={markDelivered}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="partner-heading">
            <div className="panel-head">
              <h2 id="partner-heading">Print partner</h2>
              <label className="inline-field">
                Queue for
                <select className="inline-select" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
                  {PARTNERS.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </label>
            </div>

            {jobs.length === 0 ? (
              <p className="empty">{loading ? "Loading jobs…" : `No active jobs for ${partnerId}.`}</p>
            ) : (
              <ul className="rows">
                {jobs.map((job) => (
                  <li key={job.orderId} className="row">
                    <span>
                      <span className="row-title">{formatQuantity(job.quantity)} × {job.product}</span>
                      <span className="row-meta">{job.orderId}, due {formatDue(job.neededBy)}</span>
                    </span>
                    {job.status === "SENT_TO_PARTNER" ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busyAction === `accept-${job.orderId}`}
                        onClick={() => acceptJob(job)}
                      >
                        {busyAction === `accept-${job.orderId}` ? "Accepting…" : "Accept job"}
                      </button>
                    ) : (
                      <StatusPill status={job.status} />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>

      <footer className="footnote">
        Demo build: the selectors stand in for real logins, so anyone can act as any customer or partner.
      </footer>

      <div className="toast-region" aria-live="polite">
        {toast && (
          <div key={toast.id} className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
            <span>{toast.text}</span>
            {toast.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => { toast.action.run(); setToast(null); }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  return <span className="pill" data-status={status}>{STATUS_LABELS[status] ?? status}</span>;
}

function OpsAction({ order, partnerId, busyAction, onUploadProof, onSendToPartner, onMarkDelivered }) {
  const busy = (prefix) => busyAction === `${prefix}-${order.orderId}`;

  switch (order.status) {
    case "AWAITING_PROOF":
    case "IN_PROOF":
      return (
        <button type="button" className="btn btn-secondary" disabled={busy("proof")} onClick={() => onUploadProof(order)}>
          {busy("proof") ? "Uploading…" : `Upload version ${order.currentProofVersion + 1}`}
        </button>
      );
    case "APPROVED":
      return (
        <button type="button" className="btn btn-primary" disabled={busy("assign")} onClick={() => onSendToPartner(order)}>
          {busy("assign") ? "Sending…" : `Send to ${partnerId}`}
        </button>
      );
    case "ON_PRESS":
      return (
        <button type="button" className="btn btn-primary" disabled={busy("deliver")} onClick={() => onMarkDelivered(order)}>
          {busy("deliver") ? "Saving…" : "Mark delivered"}
        </button>
      );
    default:
      return <StatusPill status={order.status} />;
  }
}

function OrderDetail({ page, busy, onApprove, onClose }) {
  if (!page) return <div className="detail"><p className="empty">Loading order…</p></div>;

  const { order, proofs, timeline } = page;
  const currentStep = ORDER_STEPS.findIndex(({ status }) => status === order.status);
  const latestProof = proofs.at(-1);
  const awaitingApproval = order.status === "IN_PROOF" && latestProof?.status === "AWAITING_APPROVAL";

  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <h3>{formatQuantity(order.quantity)} × {order.product}</h3>
          <p className="row-meta">{order.orderId}, due {formatDue(order.neededBy)}</p>
        </div>
        <button type="button" className="btn btn-quiet" onClick={onClose}>Close</button>
      </div>

      <ol className="steps" aria-label="Order progress">
        {ORDER_STEPS.map(({ status, label }, i) => (
          <li
            key={status}
            className={i < currentStep ? "is-done" : i === currentStep ? "is-current" : undefined}
            aria-current={i === currentStep ? "step" : undefined}
          >
            {label}
          </li>
        ))}
      </ol>

      {awaitingApproval && (
        <div className="approval">
          <p>
            Version {latestProof.proofVersion} is waiting for your approval. Approving locks this exact file for printing.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => onApprove(order.orderId, latestProof.proofVersion)}
          >
            {busy ? "Approving…" : `Approve version ${latestProof.proofVersion}`}
          </button>
        </div>
      )}

      <h4>Proofs</h4>
      {proofs.length === 0 ? (
        <p className="empty">The print team hasn't uploaded a proof yet.</p>
      ) : (
        <ul className="rows">
          {[...proofs].reverse().map((proof) => (
            <li key={proof.SK} className="row">
              <span>
                <span className="row-title">Version {proof.proofVersion}</span>
                <span className="row-meta">{proof.note || proof.fileKey}</span>
              </span>
              <StatusPill status={proof.status} />
            </li>
          ))}
        </ul>
      )}

      <h4>History</h4>
      <ol className="timeline">
        {timeline.map((event) => (
          <li key={event.SK}>
            <time dateTime={event.at}>{formatMoment(event.at)}</time>
            <span>{event.detail}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

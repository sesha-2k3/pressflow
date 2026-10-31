import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, QueryCommand, TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Configuration and domain constants
// ---------------------------------------------------------------------------

const TABLE = process.env.TABLE_NAME;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const OrderStatus = Object.freeze({
  AWAITING_PROOF: "AWAITING_PROOF",
  IN_PROOF: "IN_PROOF",
  APPROVED: "APPROVED",
  SENT_TO_PARTNER: "SENT_TO_PARTNER",
  ON_PRESS: "ON_PRESS",
  DELIVERED: "DELIVERED",
});
const OPEN_STATUSES = Object.values(OrderStatus).filter((status) => status !== OrderStatus.DELIVERED);

const ProofStatus = Object.freeze({
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  APPROVED: "APPROVED",
  SUPERSEDED: "SUPERSEDED",
});

const EventType = Object.freeze({
  CREATED: "CREATED",
  PROOF_UPLOADED: "PROOF_UPLOADED",
  PROOF_APPROVED: "PROOF_APPROVED",
  SENT_TO_PARTNER: "SENT_TO_PARTNER",
  ACCEPTED: "ACCEPTED",
  DELIVERED: "DELIVERED",
});

const Role = Object.freeze({ CUSTOMER: "customer", PARTNER: "partner", OPERATIONS: "operations" });

const Index = Object.freeze({
  CUSTOMER_ORDERS: { name: "CustomerOrdersIndex", partitionKey: "GSI1PK" },
  PARTNER_JOBS: { name: "PartnerJobsIndex", partitionKey: "GSI2PK" },
  OPS_QUEUE: { name: "OpsQueueIndex", partitionKey: "openStatus" },
});

const ORDER_SORT_KEY = "META";
const SortKeyPrefix = Object.freeze({ PROOF: "PROOF#", EVENT: "EVENT#" });

// Sort keys compare as text, so versions are zero-padded to keep "v010" after "v002".
const PROOF_VERSION_DIGITS = 3;
const MAX_PROOF_VERSION = 10 ** PROOF_VERSION_DIGITS - 1;
const MAX_TEXT_LENGTH = 500;

const keys = {
  orderPartition: (orderId) => `ORDER#${orderId}`,
  order: (orderId) => ({ PK: keys.orderPartition(orderId), SK: ORDER_SORT_KEY }),
  proof: (orderId, version) => ({
    PK: keys.orderPartition(orderId),
    SK: `${SortKeyPrefix.PROOF}v${String(version).padStart(PROOF_VERSION_DIGITS, "0")}`,
  }),
  // The random suffix stops two events written in the same millisecond from colliding.
  event: (orderId, at) => ({
    PK: keys.orderPartition(orderId),
    SK: `${SortKeyPrefix.EVENT}${at}#${randomUUID().slice(0, 8)}`,
  }),
  customer: (customerId) => `CUSTOMER#${customerId}`,
  partner: (partnerId) => `PARTNER#${partnerId}`,
};

// ---------------------------------------------------------------------------
// HTTP layer: routing, identity, parsing, responses
// ---------------------------------------------------------------------------

const routes = {
  "POST /orders": { role: Role.CUSTOMER, handle: createOrder, successCode: 201 },
  "GET /orders": { role: Role.CUSTOMER, handle: listMyOrders },
  "GET /orders/{orderId}": { role: Role.CUSTOMER, handle: getOrderPage },
  "POST /orders/{orderId}/proofs/{version}/approve": { role: Role.CUSTOMER, handle: approveProof },
  "GET /ops/queue": { role: Role.OPERATIONS, handle: listQueue },
  "POST /ops/orders/{orderId}/proofs": { role: Role.OPERATIONS, handle: addProof, successCode: 201 },
  "POST /ops/orders/{orderId}/assign": { role: Role.OPERATIONS, handle: assignPartner },
  "POST /ops/orders/{orderId}/deliver": { role: Role.OPERATIONS, handle: markDelivered },
  "GET /partner/jobs": { role: Role.PARTNER, handle: listPartnerJobs },
  "POST /partner/jobs/{orderId}/accept": { role: Role.PARTNER, handle: acceptJob },
};

export const handler = async (event) => {
  const route = routes[event.routeKey];
  if (!route) return respond(404, { error: "Route not found" });

  try {
    const request = {
      ...resolveIdentity(route.role, event.headers),
      params: event.pathParameters ?? {},
      query: event.queryStringParameters ?? {},
      body: parseBody(event),
    };
    return respond(route.successCode ?? 200, await route.handle(request));
  } catch (err) {
    return toErrorResponse(err);
  }
};

const IDENTITY_HEADERS = Object.freeze({
  [Role.CUSTOMER]: { header: "x-customer-id", field: "customerId" },
  [Role.PARTNER]: { header: "x-partner-id", field: "partnerId" },
});

// DEMO ONLY: identity comes from headers the caller controls. Production must read it from a
// verified token (for example, a Cognito JWT authorizer) and must also protect the operations routes.
function resolveIdentity(role, headers) {
  const source = IDENTITY_HEADERS[role];
  if (!source) return {};
  const id = (headers ?? {})[source.header];
  if (!id) throw unauthorized(`Missing ${role}`);
  return { [source.field]: id };
}

function parseBody({ body, isBase64Encoded }) {
  if (!body) return {};
  const text = isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("Body must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("Body must be a JSON object");
  }
  return parsed;
}

const respond = (statusCode, data) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const badRequest = (message) => new HttpError(400, message);
const unauthorized = (message) => new HttpError(401, message);
const notFound = (message) => new HttpError(404, message);
const conflict = (message) => new HttpError(409, message);

function toErrorResponse(err) {
  if (err instanceof HttpError) return respond(err.statusCode, { error: err.message });
  if (err.name === "TransactionCanceledException") return transactionCanceledResponse(err);
  console.error(err);
  return respond(500, { error: "Server error" });
}

function transactionCanceledResponse(err) {
  const reasons = (err.CancellationReasons ?? []).map((reason) => reason.Code);
  console.warn("Transaction canceled:", reasons);

  if (reasons.includes("ConditionalCheckFailed")) {
    return respond(409, { error: "The order isn't in the right state for that action" });
  }
  if (reasons.includes("TransactionConflict")) {
    return respond(409, { error: "Another change to this order is in progress. Please retry." });
  }
  if (reasons.includes("ThrottlingError")) {
    return respond(503, { error: "Too many requests. Please retry." });
  }
  console.error(err);
  return respond(500, { error: "Server error" });
}

// ---------------------------------------------------------------------------
// Customer use cases
// ---------------------------------------------------------------------------

async function createOrder({ customerId, body }) {
  const { product, quantity, neededBy } = validateNewOrder(body);
  const orderId = `MP-${randomUUID().slice(0, 8)}`;
  const createdAt = now();

  const order = {
    ...keys.order(orderId),
    entityType: "ORDER",
    orderId,
    customerId,
    product,
    quantity,
    neededBy,
    status: OrderStatus.AWAITING_PROOF,
    openStatus: OrderStatus.AWAITING_PROOF,
    currentProofVersion: 0,
    createdAt,
    GSI1PK: keys.customer(customerId),
  };

  await transact([
    putNew(order),
    timelineEvent(orderId, EventType.CREATED, `${quantity} × ${product}, needed by ${neededBy}`, createdAt),
  ]);
  return order;
}

function listMyOrders({ customerId }) {
  return queryIndex(Index.CUSTOMER_ORDERS, keys.customer(customerId), { ascending: false });
}

async function getOrderPage({ customerId, params }) {
  const items = await queryAll({
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": keys.orderPartition(params.orderId) },
    ConsistentRead: true,
  });

  const order = items.find((item) => item.SK === ORDER_SORT_KEY);
  assertOwnedBy(order, customerId);

  return {
    order,
    proofs: items.filter((item) => item.SK.startsWith(SortKeyPrefix.PROOF)),
    timeline: items.filter((item) => item.SK.startsWith(SortKeyPrefix.EVENT)),
  };
}

async function approveProof({ customerId, params }) {
  const { orderId } = params;
  const version = parseProofVersion(params.version);
  assertOwnedBy(await findOrder(orderId), customerId);

  await transact([
    updateItem(keys.proof(orderId, version), {
      set: { status: ProofStatus.APPROVED, approvedAt: now() },
      condition: "#status = :awaitingApproval",
      conditionValues: { ":awaitingApproval": ProofStatus.AWAITING_APPROVAL },
    }),
    transitionOrder(orderId, {
      from: OrderStatus.IN_PROOF,
      to: OrderStatus.APPROVED,
      set: { approvedProofVersion: version },
      condition: "#customerId = :customerId AND #currentProofVersion = :version",
      conditionValues: { ":customerId": customerId, ":version": version },
    }),
    timelineEvent(orderId, EventType.PROOF_APPROVED, `Version ${version} approved by the customer`),
  ]);
  return { orderId, approvedProofVersion: version };
}

// Responding "not found" rather than "forbidden" avoids revealing that someone else's order exists.
function assertOwnedBy(order, customerId) {
  if (order?.customerId !== customerId) throw notFound("Order not found");
}

// ---------------------------------------------------------------------------
// Operations use cases
// ---------------------------------------------------------------------------

function listQueue({ query }) {
  const stage = query.status ?? OrderStatus.AWAITING_PROOF;
  if (!OPEN_STATUSES.includes(stage)) {
    throw badRequest(`status must be one of: ${OPEN_STATUSES.join(", ")}`);
  }
  return queryIndex(Index.OPS_QUEUE, stage, { ascending: true });
}

async function addProof({ params, body }) {
  const { orderId } = params;
  const { fileKey, checksum, note } = validateProof(body);

  const latest = await findLatestProof(orderId);
  const previousVersion = latest?.proofVersion ?? 0;
  const version = previousVersion + 1;
  if (version > MAX_PROOF_VERSION) throw conflict("This order has reached the maximum number of proof versions");

  const writes = [
    putNew({
      ...keys.proof(orderId, version),
      entityType: "PROOF",
      orderId,
      proofVersion: version,
      fileKey,
      checksum,
      note,
      status: ProofStatus.AWAITING_APPROVAL,
      createdAt: now(),
    }),
    // Optimistic lock: fails if another upload claimed this version after we read the latest proof.
    transitionOrder(orderId, {
      from: [OrderStatus.AWAITING_PROOF, OrderStatus.IN_PROOF],
      to: OrderStatus.IN_PROOF,
      set: { currentProofVersion: version },
      condition: "#currentProofVersion = :previousVersion",
      conditionValues: { ":previousVersion": previousVersion },
    }),
    timelineEvent(orderId, EventType.PROOF_UPLOADED, `Version ${version}${note ? `: ${note}` : ""}`),
  ];

  if (latest?.status === ProofStatus.AWAITING_APPROVAL) {
    writes.push(updateItem({ PK: latest.PK, SK: latest.SK }, { set: { status: ProofStatus.SUPERSEDED } }));
  }

  await transact(writes);
  return { orderId, proofVersion: version };
}

async function assignPartner({ params, body }) {
  const { orderId } = params;
  const partnerId = requireText(body.partnerId, "partnerId");

  await transact([
    transitionOrder(orderId, {
      from: OrderStatus.APPROVED,
      to: OrderStatus.SENT_TO_PARTNER,
      // Setting GSI2PK is what places the job in the partner's queue.
      set: { partnerId, GSI2PK: keys.partner(partnerId) },
    }),
    timelineEvent(orderId, EventType.SENT_TO_PARTNER, `Assigned to ${partnerId}`),
  ]);
  return { orderId, partnerId };
}

async function markDelivered({ params }) {
  const { orderId } = params;

  await transact([
    transitionOrder(orderId, {
      from: OrderStatus.ON_PRESS,
      to: OrderStatus.DELIVERED,
      set: { deliveredAt: now() },
      remove: ["GSI2PK"],
    }),
    timelineEvent(orderId, EventType.DELIVERED, "Delivered to the customer"),
  ]);
  return { orderId, status: OrderStatus.DELIVERED };
}

// ---------------------------------------------------------------------------
// Partner use cases
// ---------------------------------------------------------------------------

function listPartnerJobs({ partnerId }) {
  return queryIndex(Index.PARTNER_JOBS, keys.partner(partnerId), { ascending: true });
}

async function acceptJob({ partnerId, params }) {
  const { orderId } = params;

  await transact([
    transitionOrder(orderId, {
      from: OrderStatus.SENT_TO_PARTNER,
      to: OrderStatus.ON_PRESS,
      condition: "#partnerId = :partnerId",
      conditionValues: { ":partnerId": partnerId },
    }),
    timelineEvent(orderId, EventType.ACCEPTED, `Accepted by ${partnerId}, now on press`),
  ]);
  return { orderId, status: OrderStatus.ON_PRESS };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateNewOrder(body) {
  const product = requireText(body.product, "product");
  if (!Number.isInteger(body.quantity) || body.quantity <= 0) {
    throw badRequest("quantity must be a positive whole number");
  }
  if (!isCalendarDate(body.neededBy)) {
    throw badRequest("neededBy must be a real date in YYYY-MM-DD format");
  }
  return { product, quantity: body.quantity, neededBy: body.neededBy };
}

function validateProof(body) {
  return {
    fileKey: requireText(body.fileKey, "fileKey"),
    checksum: requireText(body.checksum, "checksum"),
    note: body.note ? requireText(body.note, "note") : "",
  };
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} must be a non-empty string`);
  if (value.length > MAX_TEXT_LENGTH) throw badRequest(`${field} must be at most ${MAX_TEXT_LENGTH} characters`);
  return value.trim();
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function parseProofVersion(raw) {
  const version = Number(raw);
  if (!/^\d+$/.test(raw ?? "") || version < 1 || version > MAX_PROOF_VERSION) {
    throw badRequest(`version must be a whole number from 1 to ${MAX_PROOF_VERSION}`);
  }
  return version;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();

const transact = (writes) => db.send(new TransactWriteCommand({ TransactItems: writes }));

const putNew = (item) => ({
  Put: { TableName: TABLE, Item: item, ConditionExpression: "attribute_not_exists(PK)" },
});

const timelineEvent = (orderId, eventType, detail, at = now()) => ({
  Put: {
    TableName: TABLE,
    Item: { ...keys.event(orderId, at), entityType: "EVENT", eventType, detail, at },
  },
});

// Every attribute is aliased as #name so reserved words such as "status" never break an expression.
function updateItem(key, { set = {}, remove = [], condition, conditionValues = {} }) {
  const setFields = Object.keys(set);
  const conditionFields = [...(condition ?? "").matchAll(/#(\w+)/g)].map(([, field]) => field);
  const aliasedFields = new Set([...setFields, ...remove, ...conditionFields]);

  const clauses = [];
  if (setFields.length) clauses.push(`SET ${setFields.map((field) => `#${field} = :new_${field}`).join(", ")}`);
  if (remove.length) clauses.push(`REMOVE ${remove.map((field) => `#${field}`).join(", ")}`);

  const values = {
    ...Object.fromEntries(setFields.map((field) => [`:new_${field}`, set[field]])),
    ...conditionValues,
  };

  return {
    Update: {
      TableName: TABLE,
      Key: key,
      UpdateExpression: clauses.join(" "),
      ExpressionAttributeNames: Object.fromEntries([...aliasedFields].map((field) => [`#${field}`, field])),
      ...(condition && { ConditionExpression: condition }),
      ...(Object.keys(values).length && { ExpressionAttributeValues: values }),
    },
  };
}

function transitionOrder(orderId, { from, to, set = {}, remove = [], condition, conditionValues = {} }) {
  const fromValues = Object.fromEntries([from].flat().map((status, i) => [`:from${i}`, status]));
  const statusCondition = `#status IN (${Object.keys(fromValues).join(", ")})`;
  const staysOpen = OPEN_STATUSES.includes(to);

  // openStatus exists only while an order is open, so delivered orders drop out of OpsQueueIndex.
  return updateItem(keys.order(orderId), {
    set: { status: to, ...(staysOpen && { openStatus: to }), ...set },
    remove: staysOpen ? remove : [...remove, "openStatus"],
    condition: [statusCondition, condition].filter(Boolean).join(" AND "),
    conditionValues: { ...fromValues, ...conditionValues },
  });
}

function findOrder(orderId) {
  return queryFirst({
    KeyConditionExpression: "PK = :pk AND SK = :sk",
    ExpressionAttributeValues: { ":pk": keys.orderPartition(orderId), ":sk": ORDER_SORT_KEY },
    ConsistentRead: true,
  });
}

function findLatestProof(orderId) {
  return queryFirst({
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": keys.orderPartition(orderId), ":prefix": SortKeyPrefix.PROOF },
    ScanIndexForward: false,
    ConsistentRead: true,
  });
}

function queryIndex(index, partitionValue, { ascending }) {
  return queryAll({
    IndexName: index.name,
    KeyConditionExpression: `${index.partitionKey} = :value`,
    ExpressionAttributeValues: { ":value": partitionValue },
    ScanIndexForward: ascending,
  });
}

async function queryFirst(params) {
  const { Items } = await db.send(new QueryCommand({ TableName: TABLE, Limit: 1, ...params }));
  return Items[0];
}

// A single Query returns at most 1 MB, so follow LastEvaluatedKey until every page is read.
async function queryAll(params) {
  const items = [];
  let startKey;
  do {
    const page = await db.send(new QueryCommand({
      TableName: TABLE,
      ...params,
      ...(startKey && { ExclusiveStartKey: startKey }),
    }));
    items.push(...page.Items);
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

# PressFlow

**PressFlow is a mini print order flow (orders, proof approval, partner queues and delivery) built on DynamoDB, Lambda and API Gateway, with a React front end.**

It models how a print marketplace runs a job: a customer places an order, the operations team uploads proofs, the customer approves one exact file, the job goes to a partner print shop, the partner accepts it, and it's delivered. Every step is enforced by the database, not just by the UI.

---

## Architecture

```
React (Vite static site: localhost in development, CDN-hosted in production)
        │  HTTPS + CORS
        ▼
API Gateway (HTTP API, 10 routes, $default stage)
        │  payload format 2.0, event.routeKey
        ▼
Lambda Event function (Node.js, printOrdersApi)
        │  execution role: PutItem, Query, UpdateItem on one table only
        ▼
DynamoDB (PrintOrders table + 3 global secondary indexes, on-demand)
```

The backend runs in one region, **us-east-2**. The front end is a static site: during development it runs on the Vite dev server, and it can be deployed to any static host (see [Deploying the front end](#deploying-the-front-end)).

## Repository layout

```
pressflow/
├── lambda/
│   └── index.mjs        # the whole backend: routing, validation, DynamoDB access
└── orders-ui/
    ├── .env.example     # copy to .env and set VITE_API_URL
    └── src/
        ├── App.jsx      # customer, operations and partner views on one page
        ├── App.css
        └── index.css
```

---

## Data model

All three item types for an order live in the same partition, `PK = ORDER#<orderId>`, and are told apart by the sort key. A group of items that share a partition key is an **item collection**.

| Item | Sort key (`SK`) | Holds |
| --- | --- | --- |
| Order | `META` | Product, quantity, needed-by date, customer, status, current proof version, partner |
| Proof version | `PROOF#v001`, `PROOF#v002`, … | S3 file key, file checksum, note, proof status |
| Timeline event | `EVENT#<timestamp>#<random>` | What happened and when |

**Order status flow:** `AWAITING_PROOF` → `IN_PROOF` → `APPROVED` → `SENT_TO_PARTNER` → `ON_PRESS` → `DELIVERED`

### Indexes

| Index | Partition key | Sort key | Notes |
| --- | --- | --- | --- |
| `CustomerOrdersIndex` | `GSI1PK` | `createdAt` | Only order items have `GSI1PK` |
| `PartnerJobsIndex` | `GSI2PK` | `neededBy` | Sparse: set on assignment, removed on delivery |
| `OpsQueueIndex` | `openStatus` | `createdAt` | Sparse: removed on delivery |

### Access patterns

| # | Question the app asks | How DynamoDB answers it |
| --- | --- | --- |
| 1 | Show one order page: spec, all proofs, timeline | Query main table: `PK = ORDER#<id>` (one request, strongly consistent) |
| 2 | Show a customer's orders, newest first | Query `CustomerOrdersIndex`: `GSI1PK = CUSTOMER#<id>`, `createdAt` descending |
| 3 | Show a partner's job queue, soonest due first | Query sparse `PartnerJobsIndex`: `GSI2PK = PARTNER#<id>`, sorted by `neededBy` |
| 4 | Show operations the orders at one stage, oldest first | Query sparse `OpsQueueIndex`: `openStatus = <stage>`, sorted by `createdAt` |
| 5 | Find the latest proof version | Query main table: `begins_with(SK, "PROOF#")`, descending, limit 1 |
| 6 | Approve a proof | Transaction: approve the proof, update the order, add a timeline event, all or nothing, with conditions |

Every pattern is a Query on a key. There are no Scans.

---

## Key design decisions

- **One item collection per order.** The order, every proof version and the full timeline share one partition, so the order page loads in a single strongly consistent Query.
- **Three GSIs, two of them sparse.** DynamoDB only indexes items that have the index's key attribute. Removing `openStatus` and `GSI2PK` on delivery drops the order out of the operations queue and the partner queue automatically, while `GSI1PK` keeps it in the customer's history.
- **Zero-padded proof versions.** Sort keys compare as text, so `PROOF#v10` would sort before `PROOF#v2`. Padding to `v010` and `v002` makes text order match number order.
- **Conditional transactions for every state change.** Each change updates the order, writes a timeline event and, where relevant, updates a proof, all or nothing. Every update checks the current status, so actions can only happen in the right order. No partner sees a job without an approved proof, and only the assigned partner can accept it.
- **Optimistic locking on proof versions.** Uploading a proof reads the latest version, then writes with the condition `currentProofVersion = <what I read>`. If someone else uploaded first, the write fails instead of overwriting.
- **Approval is tied to the exact file.** Each proof stores its S3 key and checksum. Approval succeeds only if the proof is still awaiting approval and is still the current version, so a customer can never approve an outdated file.
- **Least-privilege IAM.** The Lambda role can only `PutItem`, `Query` and `UpdateItem` on this one table and its indexes. No Scan, no Delete, no other tables. API Gateway's permission to invoke the function is scoped to this API only.
- **Ownership check that returns 404.** A customer asking for someone else's order gets "not found" rather than "forbidden", so the API never reveals that the order exists.
- **Errors mapped by cause.** A canceled transaction is reported as 409 when a condition failed, as a retryable 409 on a concurrent conflict, and as 503 when throttled, by reading `CancellationReasons`.

---

## How the design changed

My first design, from the interview, keyed orders under the customer:

```
PK = CUSTOMER#<customerId>
SK = ORDER#<timestamp>#<orderId>
```

That's a good fit when an order is a single item and the main question is "list this customer's orders."

Once I modeled the real flow, the order stopped being a single item. It has children: several proof versions and a status timeline. The most common read became the order page, which needs the order **and** its children together.

So I made the order its own partition (`PK = ORDER#<orderId>`) and moved the customer's order list into a GSI. Two things improved:

1. **One Query loads the whole order page** instead of several requests.
2. **Looking up an order by ID no longer needs a GSI.** It's the table's primary key, so the read can be strongly consistent. In the first design, a just-created order could briefly come back "not found," because GSIs are eventually consistent.

The cost is a little extra write capacity to maintain the customer index, which is worth it for this access pattern.

---

## Setting it up

These are the steps I followed. Wherever you see a placeholder like `YOUR_ACCOUNT_ID` or `YOUR_API_ID`, use your own value.

### 1. AWS account

1. Sign in to the AWS console and confirm which identity you're using. In CloudShell, `aws sts get-caller-identity` shows it. My account signs in through an assumed role (`AccountFullAccessRole`), so I didn't need a separate IAM admin user.
2. Turn on MFA for your sign-in.
3. Optionally create a $5 monthly budget under **Billing and Cost Management → Budgets**.
4. Pick one region and use it for everything. My account's service control policy only allows **us-east-2**.

### 2. DynamoDB table

1. **DynamoDB → Tables → Create table.**
2. Table name `PrintOrders`, partition key `PK` (String), sort key `SK` (String).
3. **Customize settings → On-demand** capacity, then create.

### 3. Global secondary indexes

On the table's **Indexes** tab, under **Global secondary indexes** (not vector indexes), choose **Create index** three times. Set projections to **All** and replace the auto-filled index name each time.

| Index name | Partition key | Sort key |
| --- | --- | --- |
| `CustomerOrdersIndex` | `GSI1PK` (String) | `createdAt` (String) |
| `PartnerJobsIndex` | `GSI2PK` (String) | `neededBy` (String) |
| `OpsQueueIndex` | `openStatus` (String) | `createdAt` (String) |

Wait until all three show **Active**.

### 4. Lambda function

1. **Lambda → Create function → Event function → Author from scratch.**
2. Name `printOrdersApi`, the latest **Node.js** runtime, default execution role.
3. **Configuration → Environment variables:** `TABLE_NAME` = `PrintOrders`.
4. **Code:** replace `index.mjs` with [`lambda/index.mjs`](lambda/index.mjs), then **Deploy**.

### 5. Table permissions for the function

Add an inline policy named `PrintOrdersTableAccess` to the function's execution role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"],
      "Resource": [
        "arn:aws:dynamodb:us-east-2:YOUR_ACCOUNT_ID:table/PrintOrders",
        "arn:aws:dynamodb:us-east-2:YOUR_ACCOUNT_ID:table/PrintOrders/index/*"
      ]
    }
  ]
}
```

Transactions don't need their own permission. Each write inside one is checked against its normal action.

### 6. HTTP API

1. **API Gateway → Create API → HTTP API → Build.**
2. Integration: **Lambda**, region **us-east-2**, function `printOrdersApi`, payload version **2.0**. API name `print-orders-api`.
3. Add these 10 routes, all targeting the integration:

| Who | Route |
| --- | --- |
| Customer | `POST /orders` |
| Customer | `GET /orders` |
| Customer | `GET /orders/{orderId}` |
| Customer | `POST /orders/{orderId}/proofs/{version}/approve` |
| Operations | `GET /ops/queue` |
| Operations | `POST /ops/orders/{orderId}/proofs` |
| Operations | `POST /ops/orders/{orderId}/assign` |
| Operations | `POST /ops/orders/{orderId}/deliver` |
| Partner | `GET /partner/jobs` |
| Partner | `POST /partner/jobs/{orderId}/accept` |

4. Keep the `$default` stage with auto-deploy.

Make sure API Gateway can invoke the function on **every** route. One permission scoped to the whole API covers them all:

```bash
aws lambda add-permission \
  --function-name printOrdersApi \
  --region us-east-2 \
  --statement-id apigateway-invoke-all-routes \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:us-east-2:YOUR_ACCOUNT_ID:YOUR_API_ID/*/*"
```

### 7. CORS

The browser blocks the React page unless the API allows its origin and every custom header it sends:

```bash
aws apigatewayv2 update-api --api-id YOUR_API_ID --region us-east-2 --cors-configuration '{"AllowOrigins":["http://localhost:5173"],"AllowMethods":["GET","POST"],"AllowHeaders":["content-type","x-customer-id","x-partner-id"],"MaxAge":300}'
```

### 8. Test with curl

```bash
API=https://YOUR_API_ID.execute-api.us-east-2.amazonaws.com
C='content-type: application/json'

ORDER=$(curl -s -X POST "$API/orders" -H "x-customer-id: alice" -H "$C" \
  -d '{"product":"Product labels","quantity":5000,"neededBy":"2026-11-20"}' | jq -r .orderId)

curl "$API/ops/queue?status=AWAITING_PROOF"                                  # the new order
curl -X POST "$API/ops/orders/$ORDER/proofs" -H "$C" -d '{"fileKey":"artwork/'$ORDER'/v1.pdf","checksum":"demo-v1"}'
curl -X POST "$API/ops/orders/$ORDER/proofs" -H "$C" -d '{"fileKey":"artwork/'$ORDER'/v2.pdf","checksum":"demo-v2"}'
curl "$API/orders/$ORDER" -H "x-customer-id: alice"                           # order, 2 proofs, 3 events
curl "$API/orders/$ORDER" -H "x-customer-id: bob"                             # 404
curl -X POST "$API/orders/$ORDER/proofs/1/approve" -H "x-customer-id: alice"  # 409, superseded
curl -X POST "$API/orders/$ORDER/proofs/2/approve" -H "x-customer-id: alice"  # 200
curl -X POST "$API/ops/orders/$ORDER/assign" -H "$C" -d '{"partnerId":"press-delhi"}'
curl -X POST "$API/partner/jobs/$ORDER/accept" -H "x-partner-id: press-mexico"  # 409, wrong partner
curl -X POST "$API/partner/jobs/$ORDER/accept" -H "x-partner-id: press-delhi"   # 200
curl -X POST "$API/ops/orders/$ORDER/deliver"                                 # 200
curl "$API/ops/queue?status=ON_PRESS"                                         # []
curl "$API/partner/jobs" -H "x-partner-id: press-delhi"                       # []
curl "$API/orders" -H "x-customer-id: alice"                                  # still listed, DELIVERED
```

Queue and list calls read GSIs, which are eventually consistent, so a change can take a moment to appear.

### 9. Run the React page

```bash
cd orders-ui
cp .env.example .env      # then set VITE_API_URL to your invoke URL
npm install
npm run dev
```

Open <http://localhost:5173>. Edit the blue words in the order sentence, place an order, then move it through every stage from the operations and partner panels.

### Deploying the front end

`npm run build` produces a static site in `orders-ui/dist/`, so it can be hosted anywhere that serves static files. Options that fit this stack:

| Option | How it works | Good for |
| --- | --- | --- |
| **AWS Amplify Hosting** | Connect the GitHub repo, set the app root to `orders-ui`, add `VITE_API_URL` as an environment variable. Every push rebuilds and deploys. | The quickest way to a public HTTPS URL on AWS |
| **S3 + CloudFront** | Upload `dist/` to a private S3 bucket and serve it through a CloudFront distribution with origin access control. | Full control, and the setup most AWS production sites use |
| **Vercel or Netlify** | Import the repo, set the base directory to `orders-ui` and the `VITE_API_URL` variable. | Simple hosting outside AWS |

Two things to remember whichever you choose:

1. **Add the new origin to CORS.** The API only allows `http://localhost:5173` today. Add the deployed URL, for example `https://main.d1234abcd.amplifyapp.com`, to `AllowOrigins`, or the browser will block every request.
2. **`VITE_API_URL` is baked in at build time.** Vite replaces it while building, so set it in the host's build settings, not just in your local `.env`.

Before deploying publicly, read [Known limitations](#known-limitations): anyone with the URL could act as any customer or partner until real authentication is added.

---

## What I learned

- **Region mistakes look like permission errors.** My account's SCP allows only us-east-2, so the wrong region meant an explicit deny, even with full access.
- **The error format tells you which layer failed.** `{"message": ...}` comes from API Gateway; `{"error": ...}` comes from my code.
- **No log group means the function never ran.** API Gateway could invoke Lambda on only 4 of 10 routes; one API-wide permission fixed it.
- **A gateway 404 is a missing route, not a missing order.** Listing routes from the CLI found the absent accept route in seconds.
- **CORS is enforced by browsers, not servers.** curl passed everything while the page failed, until the API allowed the page's origin and every custom header.
- **GSIs are eventually consistent, and you can see it.** Lists briefly lagged while the strongly consistent order page never did.
- **A GSI is a separate distributed table,** which is why creating one takes minutes even on an empty table.
- **DynamoDB rejects unused expression values,** and `status` is a reserved word, so my update helper aliases every attribute.

## What I'd do next

- **Request changes and partner decline.** The customer sends a proof back (`CHANGES_REQUESTED`, order back to `AWAITING_PROOF`), and a partner declines a job (remove `GSI2PK`, order back to `APPROVED`). Both appear in MundoPrints' own interface.
- **Real artwork upload.** Presigned S3 upload URLs, with an S3-triggered Lambda that checks file type and size and stores the checksum, a small version of artwork preflight.
- **Real authentication.** Cognito with an API Gateway JWT authorizer, so customer and partner IDs come from a verified token instead of request headers, plus a staff role for the operations routes.
- **A plain-language order assistant.** Bedrock turns a brief like "5,000 waterproof labels to New Delhi by 20 Nov" into a validated spec and creates the order, handing anything unclear to a person.
- **Infrastructure as code.** Define the table, indexes, function, role, API and CORS in Terraform so the whole stack is repeatable, including the region.
- **Notifications** with SES when a proof is ready or an order ships.
- **Cursor-based pagination** for the list endpoints using `LastEvaluatedKey`.
- **Clean API responses** that hide internal keys like `PK` and `GSI1PK`.

## Known limitations

This is a demo. Customer and partner identities come from request headers that anyone can set, and the operations routes have no authentication. In production, identities and roles must come from a verified login token.

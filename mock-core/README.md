# mock-core

A mock of the Resgrid Core v4 API (see `integration.md`) for the relay's tests and local Docker Compose.

```
tsx mock-core/main.ts            # dev
node dist/mock-core/main.js      # Docker
```

Env: `PORT` (4010), `HOST` (0.0.0.0), `MOCK_CORE_API_KEY` (default `rgk_AbCdEfGh_` + 43 `s`). When run standalone (`main.ts`), it seeds the call
type `Public SOS` and priority `3` / `High`. One log line per request, never the API key.

Point the relay at it: `RESGRID_API_BASE=http://mock-core:4010`, `RESGRID_API_KEY=<same key>`.

## Control endpoints

JSON, no authentication, not recorded as Core requests. Inputs are camelCase except stored Core data
(PascalCase). Errors are `400 {"error": "..."}`.

| Method and path                        | Body / query                                                                                                                                     | Effect                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `GET /__control/state`                 |                                                                                                                                                  | Config summary and counts                                                |
| `POST /__control/reset`                |                                                                                                                                                  | Back to start-up config; drops calls, requests, faults, idempotency keys |
| `GET /__control/calls`                 | `?includeDeleted=true`                                                                                                                           | All stored calls                                                         |
| `GET /__control/calls/:id`             |                                                                                                                                                  | One call (404 if unknown)                                                |
| `POST /__control/calls/:id/state`      | `{"state": 0}`                                                                                                                                   | Dispatcher action: 0 dispatch, 1-7 close variants, 8 re-pend             |
| `DELETE /__control/calls/:id`          |                                                                                                                                                  | Dispatcher deletes the call                                              |
| `GET /__control/requests`              | `?endpoint=Calls/SaveCall&method=POST`                                                                                                           | Received requests (API key redacted here)                                |
| `DELETE /__control/requests`           |                                                                                                                                                  | Clear the request log                                                    |
| `PUT /__control/call-types`            | `["Public SOS", {"Id": 5, "Name": "EMS"}]`                                                                                                       | Replace call types ("No Type" is always added)                           |
| `PUT /__control/priorities`            | `[{"Id": 3, "Name": "High", "IsDeleted": false}]`                                                                                                | Replace priorities                                                       |
| `PUT /__control/field-policy`          | `{"Rules": [{"Key": "address", "Required": true}]}` or a bare array                                                                              | Replace policy rules                                                     |
| `PUT /__control/scopes`                | `["calls.read", "reference.read"]`                                                                                                               | Granted scopes                                                           |
| `PUT /__control/api-key`               | `{"apiKey": "rgk_..."}`                                                                                                                          | Change the accepted key                                                  |
| `PUT /__control/deleted-call-behavior` | `{"mode": "not_found"}` or `"last_state"`                                                                                                        | What GetCall returns for a deleted call                                  |
| `POST /__control/faults`               | `{"endpoint": "Calls/SaveCall", "count": 1, "status": 503, "body": "x", "retryAfter": 5, "delayMs": 0, "drop": false, "afterProcessing": false}` | Fault the next `count` requests; endpoint `*` = any                      |
| `DELETE /__control/faults`             |                                                                                                                                                  | Remove pending faults                                                    |

Fault fields: `status` (respond with it), `body` (string = text, object = JSON), `retryAfter`, `delayMs`
(alone, it only slows the request down), `drop` (kill the connection), `afterProcessing` (do the real work,
then fail: SaveCall saves the call and then answers 500 or drops).

## curl examples

```sh
M=http://localhost:4010
KEY=rgk_AbCdEfGh_ssssssssssssssssssssssssssssssssssssssssss

# What did the relay send?
curl -s "$M/__control/requests?endpoint=Calls/SaveCall" | jq

# Dispatch call 1000, then close it, then re-open it
curl -s -XPOST $M/__control/calls/1000/state -H 'content-type: application/json' -d '{"state":0}'
curl -s -XPOST $M/__control/calls/1000/state -H 'content-type: application/json' -d '{"state":1}'
curl -s -XPOST $M/__control/calls/1000/state -H 'content-type: application/json' -d '{"state":0}'

# Make the next 3 SaveCalls return 503 with Retry-After
curl -s -XPOST $M/__control/faults -H 'content-type: application/json' \
  -d '{"endpoint":"Calls/SaveCall","count":3,"status":503,"retryAfter":5}'

# Save the call, then drop the connection (client sees a network error, call exists)
curl -s -XPOST $M/__control/faults -H 'content-type: application/json' \
  -d '{"endpoint":"Calls/SaveCall","drop":true,"afterProcessing":true}'

# Require an address in the field policy
curl -s -XPUT $M/__control/field-policy -H 'content-type: application/json' \
  -d '{"Rules":[{"Key":"address","Required":true}]}'

# Remove calls.create from the key
curl -s -XPUT $M/__control/scopes -H 'content-type: application/json' -d '["calls.read","reference.read"]'

# Call the mock like Core
curl -s "$M/api/v4/Calls/GetPendingCalls" -H "X-Resgrid-ApiKey: $KEY" | jq
```

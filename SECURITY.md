# Security policy

Appliance Clinic is a live service. This repository is public and contains its production runtime and infrastructure code. Please report security problems privately and responsibly.

## Reporting a vulnerability

1. **Use GitHub private vulnerability reporting if it is offered.** If the repository's **Security** tab shows **Report a vulnerability**, use it. The report is visible only to the maintainer.
2. **Otherwise, ask for a private channel.** Open an issue titled `Security contact request` with **no technical detail**. Leave out the affected component, payloads and proof of concept. The maintainer will reply with a private channel.

There is no security email address and no bug bounty.

Please include, in the private report:
- what is affected (component, endpoint or file) and how to reproduce it;
- the impact you believe it has;
- whether you have accessed, kept or shared any data while testing.

You can expect an acknowledgement, a fix or mitigation where one is warranted, and credit if you want it. Please give a reasonable time to fix a problem before disclosing it publicly.

## Never post in a public issue, pull request or discussion

- Secrets of any kind: API keys, bearer tokens, session tokens, passwords, AWS credentials, signed URLs, private keys.
- Personal data: names, email addresses, phone numbers, addresses, or customer conversation transcripts.
- Exploit details for an unfixed vulnerability.
- Production logs, unless you have checked them for all of the above.

If you post something by mistake, tell the maintainer at once. Treat any exposed credential as compromised; the owner will rotate it, as was done for the service bearer tokens in Phase 8.

## Testing boundaries

- Do not test against the production service at `applianceclinic.ai` or its AWS endpoints. That includes:
  - automated scanning or load;
  - attempts to read other users' data;
  - attempts to reach administrative functions.
- The service shares an account-level Lambda concurrency limit with other production workloads, so load testing can harm them too.
- Static review of this repository is welcome.

## How secrets are handled here

- **Secret values are never stored in this repository.**
  - Runtime secrets live in AWS Secrets Manager under `applianceclinic/production/*`.
  - Lambdas receive secret **ids**, or values resolved at deploy time through CloudFormation dynamic references.
- **CI holds no production credentials** and cannot deploy.
- **Production changes are manual and reviewed:** [`infra/production/steps/change.sh`](infra/production/steps/change.sh) and [CONTRIBUTING.md](CONTRIBUTING.md).
- **Every push is scanned first.** Content is checked for secrets and PII before it is pushed (see [CONTRIBUTING.md](CONTRIBUTING.md#secret-and-pii-scanning)).
- **Non-secret identifiers can appear here.** Account IDs, resource names and public Function URLs are not secrets on their own. They appear in the migration record by design.

## Service-to-service authentication

| Boundary | Mechanism |
|---|---|
| Browser → whichpart-api | No sign-in on the chat route; rate-limited. The conversation-state token is HMAC-signed |
| Admin browser → whichpart-api | AC Cognito user pool, `admin` group, checked per request |
| whichpart-api and the diagnosis engine → error-code MCP | Bearer token from `applianceclinic/production/mcp-bearer` |
| Diagnosis engine → Anthropic API | The advisor's API key, write-only from the admin, in `applianceclinic/production/openai` (historical name) |
| whichpart-api → diagnosis engine | **Two checks on every request.** The Function URL uses `AWS_IAM` auth, so each call is SigV4-signed with the caller's role, and only the whichpart-api role (and the retired orchestrator's) may invoke it. Every POST also carries an HMAC-SHA256 signature over the exact body (`x-ac-engine-signature`, 5-minute window, constant-time compare; [ADR 0017](docs/adr/0017-authenticate-orchestrator-only-engine-fields.md)) |

- **No anonymous engine path.** An unsigned or wrongly signed request is refused (`401 engine_signature_required`) and
  logged; an alarm fires on any refusal. There is no plain request the engine will serve
  ([ADR 0019](docs/adr/0019-dedicated-canonical-diagnosis-engine.md)).
- **No CORS on the engine.** It is not callable from a browser.
- **Least privilege.** The engine's role (`ac-diagnosis-engine-role`) can write only its own log group, read only the AC
  AI secrets (`applianceclinic/production/{ai-config,openai}`), write to its learning prefix and read media overlays.
- **Historical names.** Some production resources keep names from before the separation, such as
  `spares4repairs-diag-orchestrator` and `spares4repairs-error-code-mcp`. Renaming a Lambda function means replacing it.
  The names do not grant any other system access.

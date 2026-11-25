# Hosting

## A small, cheap AWS shape that worked

- One ECS cluster on **one EC2 instance** (Graviton, arm64) runs the API and the worker as services. Start at 4 GB:
  2 GB ran out of memory as soon as one-shot tasks (migrations, seed, smoke test) ran beside the services.
  Give one-shot tasks a small memory reservation (about 128 MiB), or they can't be placed at all.
- **RDS Postgres**, smallest size, in a private subnet. Keep the pool small per process (3) and in tests (2):
  many parallel test workers exhaust 100 connections fast.
- **A sealed sandbox** for anything that parses untrusted files: a Fargate task in a subnet with no internet, reached
  only through VPC endpoints (ECR API, ECR DKR, CloudWatch Logs as interface endpoints; S3 as a gateway endpoint,
  which is free). The interface endpoints are the biggest fixed cost at small scale; see [costs](costs.md).
- **Container images carry the RDS CA bundle** and set `NODE_EXTRA_CA_CERTS`; otherwise migrations fail with
  "self-signed certificate" on a TLS connection to RDS.
- **ECS services ignore Terraform's task definition** (`lifecycle { ignore_changes = [task_definition] }`), so only
  a deploy moves a service to a new image. Without it, a `terraform apply` rolls staging back to Terraform's
  placeholder image.
- **Instance resizes disconnect the ECS agent.** Clearing the agent's data directory over SSM and deregistering the
  stale container instance brought it back. Ask before doing this on anything shared.

## When AWS refuses a service

A new AWS account can be refused CloudFront ("Your account must be verified before you can add new CloudFront
resources") and kept in the SES sandbox. Both are support cases that take days. Don't wait:

- **Check status by trying it**, not by reading the case: create a disabled test resource; the error says whether
  the account is verified. (Support-case APIs need a paid support plan.)
- **Stand-in front door for staging:** API Gateway HTTP API in front of the instance, and one API Gateway per static
  site in front of an S3 website bucket. Limits to write down: 10 MB per request, 30 s per answer, no cache.
  Set the app's upload limit from a build setting so staging says 10 MB and refuses bigger files before sending.
- **Or skip the wait:** Cloudflare as the front door (DNS, static files on R2, the API through a Tunnel). See
  [cloudflare](cloudflare.md). This removes the CloudFront dependency entirely.

## Names and certificates

- Owning a domain (registrar) and running its DNS are separate jobs. The registrar can stay where it is; only the
  nameservers move.
- A wildcard certificate (`*.staging.example.com`) in ACM needs one validation CNAME that must stay in DNS for good,
  or renewal fails.
- Cloud-generated hostnames (API Gateway's `d-…` names, CloudFront's) are stable while the resource exists. Recreate
  the resource and they change, so point your own names at them with CNAMEs and never hard-code theirs.

## Explain it with a picture

Owners new to cloud networking understood "three rooms" best: the public server room, the sealed sandbox room and
the sealed database room, with doors (security groups, endpoints) drawn between them.

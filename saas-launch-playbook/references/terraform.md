# Terraform

## How it runs

No SSH and no server logins: Terraform runs on one machine and calls each provider's HTTPS API.

- **AWS:** the operator's short-lived login (`aws login --profile <name>`). When it expires, plans fail with "No
  valid credential sources found"; the human logs in again.
- **Cloudflare:** the bootstrap token read from the secret store into the command's environment only:
  `export CLOUDFLARE_API_TOKEN=$(aws ssm get-parameter --with-decryption --name <path> --query Parameter.Value --output text)`.
- **State** in an encrypted S3 bucket. It holds every generated secret (database password, minted tokens), so treat
  the bucket as secret.
- A provider that is configured but unused (count 0 everywhere) must still pass `validate` and `plan` without its
  token, so production can share the module before it uses the provider.

## Layout that worked

- One module, one root per environment; per-environment values in a **git-ignored `terraform.tfvars`** beside the
  root (account ids, feature switches). Commit an example instead.
- Optional features behind one variable each (`cloudflare_account_id = null` means nothing on Cloudflare), so
  existing environments plan with zero changes.
- Pin providers to an exact version at least two weeks old; commit the lock files for every platform you run on.
- Module tests with mocked providers (`terraform test`) for every resource and setting a feature adds.
  Data sources returning lists of objects can't be mocked: put them in a tiny child module and override its output.
- Keep one long-lived checkout for applies (it holds the tfvars, backend config and `.terraform/`); update it to the
  merged commit before each apply.

## Read every plan

Plans contained changes nobody asked for. Classify each before applying:

- **Re-registered task definitions** ("must be replaced") are expected when settings are added, and harmless if the
  services ignore Terraform's task definition. **But** a re-registered *one-shot* task (one that is started by its
  family name, so the latest revision wins) picks up Terraform's placeholder image tag and breaks until the next
  deploy. Apply with `-var image_tag=<the deployed tag>`.
- **Policies shown as fully rewritten** usually only reference an ARN that is "known after apply".
- **Provider defaults** (a `0` the API reports where you set nothing) are harmless drift.

## Staging applies without asking

Agree with the owner once that staging applies need no per-apply approval, and write it down. Production, secrets
and spending stay theirs. If a tool or permission system refuses an apply, report it; don't work around it.

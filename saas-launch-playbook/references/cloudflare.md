# Cloudflare

## What to put there

- **Files people download a lot** (3D models, bundles, media): **R2**. It charges nothing for downloads (zero egress).
  That is what makes a flat price with no traffic limit safe. Prices seen on Cloudflare's page in Nov 2026:
  10 GB a month free, then $0.015 per GB-month; 1M writes (Class A) a month free, then $4.50 per million;
  10M reads (Class B) a month free, then $0.36 per million. Check again before relying on them.
- **Short links and per-item routing:** a **Worker** that reads a small pointer object from R2 and answers
  (serve, redirect, gone). The API writes pointers; the Worker only reads.
- **Static front ends:** R2 (or Pages) behind your own names.
- **The API:** stays on your server, reached through a **Cloudflare Tunnel** (`cloudflared` on the server connects
  out). No open port, no load balancer, no API Gateway. The free plan's request size limit is far above API
  Gateway's 10 MB (confirm the number on Cloudflare's docs).
- **Stays elsewhere:** database, worker, private uploads, email.

## DNS move

- The domain stays registered where it is; only the nameservers change to Cloudflare's two.
- Before switching, add every existing record in Cloudflare (it imports most), with every record **"DNS only"**
  (grey cloud) at first. Easy to miss: the registrar's own mail MX records, SPF and other TXT verification records
  (marketing tools add them), the email provider's DKIM CNAMEs, certificate validation CNAMEs, test-mailbox MX,
  and every staging CNAME. A missed MX record silently stops mail.
- After the move, manage every record in Terraform with the Cloudflare provider; the registrar needs no API.

## Tokens

- One **bootstrap token** for Terraform, made by hand. Permissions that were needed: account-level R2 storage edit,
  Workers edit, Tunnel edit, account API tokens edit (so Terraform can mint narrower tokens); zone-level DNS edit,
  zone edit, Workers routes edit. Expire it (one year). Store it in the secret store, never in tfvars.
- **Per-bucket keys from Terraform:** an account API token limited to "Workers R2 Storage Bucket Item Read/Write" on
  one bucket resource (`com.cloudflare.edge.r2.bucket.<account>_<jurisdiction>_<bucket>`). Look the permission
  groups up by name, never hard-code their ids. R2's S3-style credentials are the token's id (access key) and the
  SHA-256 hex of its value (secret), per Cloudflare's R2 tokens page.
- Let the human click the final "Create token" and copy the value; the agent can fill the form up to the review.

## App changes this needed

- The app's object storage port needs **per-store settings** (endpoint, keys, region) so published files can live on
  R2 while private files stay on S3. Each unset value falls back to the shared one, so local MinIO keeps working.
  Half a key pair is refused at start-up. R2's region is `auto`.
- **Order of a switch:** deploy the code that reads the new settings, apply the infrastructure that sets them, copy
  existing objects across, then redeploy so tasks pick the settings up.

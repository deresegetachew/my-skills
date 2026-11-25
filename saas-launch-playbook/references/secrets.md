# Secrets

## Where they live

- **Local development:** SOPS + age, encrypted files in the repo (`secrets/dev.yaml`), decrypted at start-up by one
  loader. Placeholder `REPLACE_ME` counts as unset.
- **Staging and production:** AWS Systems Manager **Parameter Store**, `SecureString` values under
  `/<app>/<env>/<NAME>`, encrypted with KMS. ECS hands them to tasks as environment variables at start; nothing is in
  images or files. Free on the standard tier; every read and change is in CloudTrail; versions are kept.
  (Secrets Manager adds rotation for about $0.40 per secret a month; not needed at first.) Plain settings sit beside
  them as `String`.
- **KMS** holds the encryption keys; AWS-managed keys are free, customer-managed ones cost about $1 a month.
- **CI/CD:** the deploy assumes an AWS role through GitHub OIDC; GitHub holds no AWS keys. The role's trust needs the
  exact subject. On some organisations it includes ids (`repo:<owner>@<id>/<repo>@<id>:environment:<env>`); read the
  real subject from CloudTrail's denied `AssumeRoleWithWebIdentity` event instead of guessing.

## The owner enters every secret

The agent never sees a secret. It gives the owner one command that reads without echoing and pipes straight in:

```sh
read -rs VALUE && printf %s "$VALUE" | aws ssm put-parameter --profile <p> --region <r> --overwrite \
  --type SecureString --name /<app>/<env>/<NAME> --value file:///dev/stdin; unset VALUE
```

- A random secret nobody needs to know (signing keys): `openssl rand -hex 32 | aws ssm put-parameter … --value file:///dev/stdin`.
  Some must never change once used (anything that signs published content); say so.
- Copying a local SOPS secret to staging, without showing it:
  `sops -d --extract '["section"]["key"]' secrets/dev.yaml | aws ssm put-parameter … --value file:///dev/stdin`.
- **Verifying without reading:** check the parameter's version and date, its length, and at most its public prefix
  (`sk_test_`, `whsec_`, `sk-ant`) to prove it is the right kind and not a placeholder.
- Terraform creates empty secret slots with placeholders and ignores later value changes (`ignore_changes = [value]`),
  so a human-entered value is never overwritten by an apply.
- Never put secrets in URLs, tfvars, logs or chat. Error messages from config loaders must not echo values.

# Email

## Sending (AWS SES)

- Verify the **root domain** (DKIM: three CNAMEs at the DNS host), and send from it (`no-reply@example.com`), not from
  a staging subdomain. Use a configuration set and an SNS topic for bounces and complaints, and test them with the
  SES mailbox simulator.
- **New accounts start in the sandbox:** mail only to verified addresses, 200 a day, 1 a second. Production access is
  a support case; answer it with how bounces and complaints are handled (the feedback loop you built). A first
  "DENIED" can be reopened by replying.
- Keep marketing mail on a different tool and domain reputation than transactional mail.

## A test mailbox the agent can read

To test sign-in codes end to end without anyone's inbox:

1. A subdomain for tests (`test.example.com`) with an MX record to SES inbound in your region.
2. An SES receipt rule that saves every message to a **private S3 bucket** under `inbox/`, deleted after 7 days.
3. The test script signs up with a fresh address per run (`<run-id>@test.example.com`), reads the newest object,
   and parses the **body** (not the headers, which hold other 6-digit numbers) for the code.
4. Use a fresh address per run: sign-in rate limits (for example 5 codes an hour) are correct behaviour and will
   otherwise fail the run.

Verify the test subdomain as an SES identity too, so the sandbox lets staging send to it.

## Who sends what

With a merchant of record (Stripe Managed Payments), receipts and payment emails come from the payment provider.
The app still sends its own emails (sign-in codes, "your item is ready"), so SES production access is still needed
before launch.

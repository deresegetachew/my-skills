# Costs

## Read the bill by service, weekly

```sh
aws ce get-cost-and-usage --region us-east-1 --time-period Start=<month start>,End=<tomorrow> \
  --granularity MONTHLY --metrics UnblendedCost \
  --filter '{"Dimensions":{"Key":"RECORD_TYPE","Values":["Usage"]}}' --group-by Type=DIMENSION,Key=SERVICE
```

Group by `RECORD_TYPE` to see whether credits cancel the usage; group a service by `USAGE_TYPE` to find the line.
Add an AWS budget alert from the first day.

## What a small staging cost (eu-north-1, Nov 2026)

About $2 a day, roughly $60 a month if left on:

| Item | Share |
|---|---|
| VPC interface endpoints (3, for the sealed sandbox) | the largest: about $0.85 a day |
| RDS Postgres, smallest | about $0.40 a day |
| One t4g.medium instance | about $0.80 a day |
| Public IPv4 addresses, logs, storage, KMS | cents |

- Interface endpoints are billed per hour per endpoint per AZ, whether used or not. Use one AZ for staging, the free
  S3 **gateway** endpoint, and switch the interface endpoints off while nothing runs in the sandbox.
- Leftovers from abandoned attempts (a WAF ACL) keep billing; delete them.
- Moving the front door to Cloudflare doesn't change these costs; it removes per-GB download charges in production.
- The cheapest lever for staging is turning it off when nobody tests (instance, database, endpoints); bringing it
  back takes minutes but pauses testing.

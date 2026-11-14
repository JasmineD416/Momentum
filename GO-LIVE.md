# Taking Momentum live (GitHub + Akamai)

The code lives on **GitHub**. Each time a change reaches the `main` branch, GitHub Actions tests it, builds a server image and updates your **Akamai (Linode)** server. Staff sign in with Google, through sign-in built into Momentum.

Steps marked **You** need your own accounts and passwords, so only you can do them. Everything else is a command you can run, or Claude can run for you.

Plan for about two hours. Costs, roughly:
- Server: Linode Shared CPU 2 GB, about US$12 a month.
- Akamai Backups: about US$3 a month.
- Object Storage: about US$5 a month for backups.
- GitHub and Google sign-in: free.

```
GitHub (code) ──push to main──▶ GitHub Actions: test → build image → update the server
                                                                     │
Staff ──HTTPS──▶ Akamai server in Toronto: Caddy (HTTPS) → Momentum (Node) → SQLite file
                                                                     └─▶ Litestream → Akamai Object Storage (backups)
```

---

## Before you start: where the data is stored

Run the server in Akamai's **Toronto (ca-central)** region, and the database stays on a disk in Canada. Email addresses also go to Amazon SES in Canada (`ca-central-1`) when mail is sent. Backups go wherever you create the Object Storage bucket in step 4. Confirm this fits the firm's privacy and Law Society obligations before importing real client records.

---

## 1. GitHub repository (You, or Claude with your go-ahead)

1. In your GitHub organization, create a **private** repository named `momentum`, and don't add a README.
2. Push this folder to it (Claude can do this once you say which organization):

   ```bash
   git remote add origin https://github.com/YOUR-ORG/momentum.git
   ```

   ```bash
   git push -u origin main
   ```

3. Turn on two-factor authentication for everyone with access: **Organization › Settings › Authentication security**.
4. Protect `main`: **Repository › Settings › Rules** › require a pull request and the **Test** check before merging.

## 2. Akamai server (You)

1. Sign in to **cloud.linode.com** (Akamai Cloud Manager).
2. **Create › Linode**:
   - Image: **Ubuntu 24.04 LTS**.
   - Region: **Toronto, CA**.
   - Plan: **Shared CPU › Linode 2 GB**.
   - Label: `momentum`.
   - Use a long root password, and add **your own** SSH key.
   - Turn on **Backups**.
3. **Create › Cloud Firewall** named `momentum`. Inbound policy: drop, with rules allowing **SSH (22)**, **HTTP (80)** and **HTTPS (443)**. Attach it to the Linode.
4. Note the Linode's **IPv4 address**.

## 3. Prepare the server (one command each)

Make a key that GitHub will use to deploy. Run it on your computer, in this folder:

```bash
ssh-keygen -t ed25519 -N "" -C github-deploy -f momentum-deploy
```

This creates `momentum-deploy` (private) and `momentum-deploy.pub` (public). Never commit the private file; you'll paste it into GitHub in step 8, then delete it.

Copy the setup script to the server and run it. It installs Docker, firewall rules and automatic security updates, and creates a `deploy` user:

```bash
scp deploy/setup-server.sh root@SERVER-IP:
```

```bash
ssh root@SERVER-IP "bash setup-server.sh '$(cat momentum-deploy.pub)'"
```

## 4. Backup storage (You)

1. **Cloud Manager › Object Storage › Create bucket**, named for example `jdco-momentum-backups`. Pick **Toronto** if it's offered for Object Storage. If not, choose the nearest region; your backups then sit outside Canada.
2. **Access keys › Create access key**, limited to that bucket with **Read/Write**. Keep the access key and secret for step 7.
3. Note the bucket's **endpoint**, for example `https://REGION.linodeobjects.com`.

## 5. Google sign-in (You)

1. Go to **console.cloud.google.com**, signed in with the firm's Google Workspace admin account, and create a project named `Momentum`.
2. **Google Auth Platform › Branding:**
   - App name: Momentum.
   - Support email: yours.
   - Authorized domain: `jdlawyers.ca`.
3. **Audience:**
   - Choose **Internal** if every staff member signs in with an `@jdlawyers.ca` Google Workspace account.
   - Otherwise choose **External** and publish the app.
4. **Clients › Create client › Web application:**
   - Name: Momentum.
   - **Authorized redirect URI:** `https://momentum.jdlawyers.ca/auth/callback`.
5. Copy the **Client ID** and **Client secret** for step 7.

## 6. Web address (You)

Wherever `jdlawyers.ca`'s DNS is managed (Akamai Edge DNS, Linode DNS Manager, or your registrar), add:

```
momentum.jdlawyers.ca   A      SERVER-IPv4
momentum.jdlawyers.ca   AAAA   SERVER-IPv6   (optional)
```

The server gets its HTTPS certificate automatically on first start, once this record points at it.

## 7. Server settings (You)

Sign in to the server as `deploy` and create the settings file from the template `deploy/server.env.example`:

```bash
ssh -i momentum-deploy deploy@SERVER-IP
```

```bash
nano /opt/momentum/.env
```

Fill in:
- `MOMENTUM_IMAGE=ghcr.io/YOUR-ORG/momentum`, in lower case.
- The web address.
- `OWNER_EMAIL=jasmine@jdlawyers.ca`.
- The Google client ID and secret.
- The backup bucket, endpoint and keys.
- A `SESSION_SECRET`. Generate one on the server with `openssl rand -base64 48`.

Leave the email settings until section 13. Then lock the file:

```bash
chmod 600 /opt/momentum/.env
```

## 8. Connect GitHub to the server (You)

In the repository: **Settings › Environments › New environment** `production`. Optionally add yourself as a required reviewer, so every deploy waits for your click. Add these to the environment:

| Kind | Name | Value |
|---|---|---|
| Secret | `DEPLOY_HOST` | the server IP |
| Secret | `DEPLOY_SSH_KEY` | the whole contents of `momentum-deploy` (the private file) |
| Secret | `DEPLOY_KNOWN_HOSTS` | the output of `ssh-keyscan SERVER-IP` |
| Variable | `PUBLIC_URL` | `https://momentum.jdlawyers.ca` |

Then delete the local `momentum-deploy` private key file. If you ever need a new one, repeat step 3's key command and update the secret.

## 9. First deploy

Push to `main`, or open **Actions › Deploy › Run workflow**. The workflow:
1. Runs the tests.
2. Builds the image and stores it privately in GitHub's container registry.
3. Copies `deploy/compose.yml`, `Caddyfile` and `litestream.yml` to `/opt/momentum`.
4. Starts the app, Caddy and the backup streamer.
5. Waits for `https://momentum.jdlawyers.ca/healthz` to answer.

The database tables are created automatically on first start.

## 10. First sign-in (You)

1. Open the site and choose **Sign in with Google** with `jasmine@jdlawyers.ca`. You'll land on the Overview as Owner.
2. Check that it's locked: in a private window, sign in with a Google account that isn't a member. Momentum should say it isn't a Momentum member and show nothing else.

## 11. Add staff

**People and access › Add staff member.** Use each person's exact Google sign-in email, then tick their divisions. Only you can grant JD&Co Law Firm, Accounting and JD Publishing. That's the only list: anyone not on it, or turned off, can't get in. Have each person sign in once; their row then shows **Signed in: Yes**.

## 12. Import your client records

The import files are in Box: **#Clients - JD&Co › Momentum import - live app (2026-10-26)**.

In **Administration › Import records**, import them in this order. For each one: choose the type, choose the file, **Preview**, check the rows, then **Commit**.

1. Clients: `1-clients.csv` (30)
2. Matters: `2-matters.csv` (30: 28 Open and 2 Transferred)
3. Client expenses: `3-client-expenses-part-1.csv` (64)
4. Client expenses: `4-client-expenses-part-2.csv` (64)

Expected totals afterwards: **$20,990.79 CAD** and **$39.57 USD**. Four expenses with no date or amount were left out:
- two MTO searches
- LAWPRO for J1164
- the Ontario Courts portal fee for J1165

Add them by hand once you have the details.

## Backups (check before relying on it)

There are three layers:
- **Litestream:** streams every database change to Object Storage within about a second, and keeps 30 days.
- **Akamai Backups:** a nightly copy of the whole server.
- **Your own export:** a copy you download yourself, described below.

Make an offline copy (weekly, for example), and keep it in a restricted Box folder:

```bash
ssh deploy@SERVER-IP "cd /opt/momentum && docker compose run --rm -v /tmp:/out backup restore -o /out/momentum-backup.db /data/momentum.db"
```

```bash
scp deploy@SERVER-IP:/tmp/momentum-backup.db .
```

Rehearse a restore once before importing more data. Open the downloaded copy with any SQLite viewer and check the client count.

## 13. Email sending (replaces Sender and HubSpot email)

Momentum sends mass email through **Amazon SES**, which costs about **US$0.10 per 1,000 emails**. Momentum handles the lists, consent, unsubscribes, bounces and the send queue; SES delivers the mail. Plan for an afternoon, plus about a day waiting for Amazon to approve production sending.

No software can guarantee the inbox. What keeps mail out of spam is:
- an authenticated domain (DKIM, SPF, DMARC)
- only emailing people who agreed to it
- one-click unsubscribe
- removing bounces and complainers
- warming up new domains slowly

Momentum enforces the parts it can; the DNS records and warm-up below are yours.

### 13.1 Amazon account and domains (You)

1. Sign up at **aws.amazon.com** with the firm's email and turn on two-factor authentication for the root user.
2. Switch the region (top right) to **Canada (Central) ca-central-1**.
3. **Amazon SES › Identities › Create identity › Domain**, once per sending domain (for example `lawgirl.ca`, `cbpla.ca`, `jdlawyers.ca`).
   - Choose **Easy DKIM, RSA 2048**.
   - Under **Custom MAIL FROM domain**, use `mail.<domain>`.
4. SES shows DNS records: three DKIM `CNAME`s, plus an `MX` and a `TXT` (SPF) for the MAIL FROM domain. Add them wherever each domain's DNS is hosted. Also add a DMARC record:

   ```
   _dmarc.<domain>   TXT   v=DMARC1; p=none; rua=mailto:dmarc@<domain>
   ```

   Once mail has gone out cleanly for a month, change `p=none` to `p=quarantine`.
5. Wait until each identity shows **Verified**, usually under an hour. In Momentum, **Email lists › Check domain** shows the same status.
6. **SES › Account dashboard › Request production access.**
   - Mail type: Marketing.
   - Describe how you work: people opt in or are recent clients and inquirers, every email has one-click unsubscribe and a postal address, and bounces and complaints are suppressed automatically.
   - Until this is approved, SES only sends to addresses you verified yourself.

### 13.2 Bounces and complaints back to Momentum (You)

1. On the server, run `openssl rand -hex 32` and keep the result as your **SES_WEBHOOK_TOKEN**.
2. **Amazon SNS › Topics › Create topic** (Standard), named `momentum-ses-events`. Copy its ARN.
3. Create a subscription on the topic:
   - Protocol: **HTTPS**.
   - Endpoint: `https://momentum.jdlawyers.ca/hooks/ses?token=<SES_WEBHOOK_TOKEN>`.
   - It confirms itself once step 13.4 is done.
4. **SES › Configuration sets › Create set** named `momentum`. Add an **event destination**:
   - Event types: **Hard bounces** and **Complaints**.
   - Destination: **Amazon SNS**, using the topic above.

The unsubscribe page (`/u/…`) and this notification address (`/hooks/ses`) are open to the public by design; everything else needs a Momentum sign-in.

### 13.3 Sending key (You)

**IAM › Users › Create user** `momentum-mailer`, with no console access and only this inline policy:

```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": ["ses:SendRawEmail", "ses:SendEmail", "ses:GetEmailIdentity"], "Resource": "*" }] }
```

Create an **access key** for it (use case: application running outside AWS). Never paste it into chat, GitHub or a committed file.

### 13.4 Connect Momentum

In `/opt/momentum/.env` on the server, fill in:
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
- `SES_TOPIC_ARN`
- `SES_WEBHOOK_TOKEN`
- `EMAIL_SIGNING_SECRET`: generate it with `openssl rand -base64 48`. It signs unsubscribe links, and changing it later breaks links in emails already sent.

Then restart:

```bash
ssh deploy@SERVER-IP "cd /opt/momentum && docker compose up -d"
```

The server sends queued mail once a minute, `SEND_BATCH_SIZE` messages at a time. The default is 100 a minute, about 144,000 a day.

### 13.5 Set up each business and move lists over

1. **Email lists › Sender settings** for each business:
   - from name, and a from address on its verified domain
   - reply-to
   - postal address and logo
   - a **daily limit of 200** to start
2. Export **subscribed contacts only** from Sender (Subscribers › Export) and HubSpot (Contacts › Export). Leave out unsubscribed, bounced and spam-complaint contacts. If you have those lists, import them into **Blocked addresses** so they're never emailed.
3. **Import contacts** per business. Choose the consent that applies, and where it came from:
   - express: they signed up
   - implied: a purchase within 2 years, or an inquiry within 6 months
4. Send each new mailing to yourself first (**Send me a test**) and check it in Gmail and Outlook.
5. **Warm up** each new domain:
   - About 200 a day the first week, then roughly double each week (400, 800, 1,600 …) while bounces stay under 2% and spam reports under 0.1%. Raise the daily limit as you go.
   - Momentum queues anything over the limit for the next day.
   - It pauses a mailing on its own if bounces pass 5% or spam reports pass 0.3%.
6. Register each domain with **Google Postmaster Tools** (postmaster.google.com) to watch your Gmail reputation.
7. Keep Sender and HubSpot until each business has sent a few clean mailings from Momentum, then cancel them.

## Updating the app later

Make changes on a branch and open a pull request; the **Test** workflow runs on it. Merge to `main` and **Deploy** does the rest.

New database changes go in new numbered files in `migrations/`. They apply automatically when the new version starts, and Litestream has the moment before.

To go back to an earlier version, set `MOMENTUM_TAG=<commit sha>` in `/opt/momentum/.env` and run `docker compose up -d`.

## Retiring the Cloudflare trial

Momentum briefly ran on Cloudflare. The `momentum` Worker (momentum.jdco.workers.dev) and its D1 database hold no client data. Delete both from the Cloudflare dashboard (**Workers & Pages** and **D1**) once the Akamai server is up.

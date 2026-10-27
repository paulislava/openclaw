---
name: nosmoke-push
description: "Send NoSmoke iOS push notifications through the production backdoor."
---

# NoSmoke Push

Use when Павел asks to send a NoSmoke push notification or notification backdoor message.

Run the global helper:

```bash
nosmoke-push --body "Текст уведомления" --title "NoSmoke" --url "https://nosmoke.paulislava.space/"
```

Rules:

- Default recipient is the backend-configured account. Do not add `--username`, `--user-id`, or `--device-token` unless Павел explicitly asks for another target.
- The helper reads `PUSH_BACKDOOR_KEY` from env or `~/Desktop/Projects/NoSmoke/backend/.env`; never print the key.
- If a target is explicitly needed, pass exactly one of `--username`, `--user-id`, or `--device-token`.
- Check and report the HTTP status/body. `2xx` means the backdoor accepted the send; `404` means no APNs token for that target; `400` usually means missing/default target config.

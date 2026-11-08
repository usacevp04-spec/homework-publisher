# MESh Playwright diagnostic

This first milestone verifies that GitHub Actions can start Chromium and reach the MESh diary entry point.

Run manually from GitHub Actions: **MESh Playwright diagnostic** → **Run workflow** on branch `feature/mesh-playwright`.

This job intentionally does not log in, capture cookies, collect answers, or publish to Telegram. It logs only the page origin, headings, and presence of the assignments navigation / password field.

Next milestone: implement a user-authorized login strategy, inspect DOM locators from a safe test session, then add read-only result parsing. Keep secrets in GitHub Actions Secrets and never put account credentials, auth query strings, cookies or storageState in source control.

Do not enable hourly scheduling until diagnostics and login/session persistence have been tested.

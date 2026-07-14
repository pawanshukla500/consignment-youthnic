# Firebase Auth Email Templates — Youthnic Packing Station

Configure these in **Firebase Console → Authentication → Templates**. Each template has the same fields; paste the matching HTML into the **Message body** field. The subject lines and "From" address you set once.

> Firebase will substitute the placeholders automatically:
> - `%APP_NAME%` → your app's display name
> - `%LINK%` → the action URL (verify / reset / change)
> - `%EMAIL%` → recipient email
> - `%DISPLAY_NAME%` → user's display name (may be empty)
> - `%NEW_EMAIL%` → only for email-change template

---

## Common Settings

| Field | Value |
|---|---|
| **Sender name** | `Youthnic Packing Station` |
| **From** | `noreply@youthnic.shop` |
| **Reply to** | *(leave empty)* |

---

## 1. Password Reset / Set Password

**Subject:** `Set your password for Youthnic Packing Station`

**Message body (HTML):**

```html
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr><td align="center" style="padding:32px 16px">
      <table width="560" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%">
        <tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:16px 16px 0 0;padding:32px;text-align:center">
          <p style="margin:0;font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px">Youthnic</p>
          <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,.7);letter-spacing:1.5px;text-transform:uppercase">Packing Station</p>
        </td></tr>
        <tr><td style="background:#fff;padding:36px 40px">
          <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a">Set your password</p>
          <p style="margin:0 0 24px;font-size:14px;color:#64748b;line-height:1.6">
            Hi %DISPLAY_NAME%, an account has been created for you on the <strong>Youthnic Packing Station</strong>.
            Click the button below to set your password and sign in.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 28px">
            <tr><td align="center">
              <a href="%LINK%" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:14px 36px;border-radius:10px;letter-spacing:0.3px;box-shadow:0 4px 14px rgba(79,70,229,.35)">Set My Password →</a>
            </td></tr>
          </table>
          <p style="margin:0 0 12px;font-size:12px;color:#94a3b8">Or copy this link into your browser:</p>
          <p style="margin:0 0 24px;font-size:12px;color:#4f46e5;word-break:break-all;background:#f8fafc;border:1px solid #e2e8f0;padding:10px 14px;border-radius:8px;font-family:monospace">%LINK%</p>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px">
            <tr><td style="padding:12px 16px">
              <p style="margin:0;font-size:12px;color:#c2410c"><strong>Security:</strong> This link expires in 1 hour. If you didn't expect this email, you can safely ignore it.</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;border-radius:0 0 16px 16px;padding:20px 40px;text-align:center">
          <p style="margin:0;font-size:11px;color:#94a3b8">© 2025 Youthnic Exports Pvt. Ltd. — Packing Station<br>This is an automated message · Please do not reply directly</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>
```

---

## 2. Email Address Verification

**Subject:** `Verify your email — Youthnic Packing Station`

**Message body (HTML):**

```html
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr><td align="center" style="padding:32px 16px">
      <table width="560" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%">
        <tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:16px 16px 0 0;padding:32px;text-align:center">
          <p style="margin:0;font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px">Youthnic</p>
          <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,.7);letter-spacing:1.5px;text-transform:uppercase">Packing Station</p>
        </td></tr>
        <tr><td style="background:#fff;padding:36px 40px">
          <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a">Verify your email</p>
          <p style="margin:0 0 24px;font-size:14px;color:#64748b;line-height:1.6">
            Hi %DISPLAY_NAME%, please click the button below to verify <strong>%EMAIL%</strong> and finish setting up your account.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 28px">
            <tr><td align="center">
              <a href="%LINK%" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:14px 36px;border-radius:10px;letter-spacing:0.3px;box-shadow:0 4px 14px rgba(79,70,229,.35)">Verify Email →</a>
            </td></tr>
          </table>
          <p style="margin:0 0 12px;font-size:12px;color:#94a3b8">Or copy this link:</p>
          <p style="margin:0 0 24px;font-size:12px;color:#4f46e5;word-break:break-all;background:#f8fafc;border:1px solid #e2e8f0;padding:10px 14px;border-radius:8px;font-family:monospace">%LINK%</p>
        </td></tr>
        <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;border-radius:0 0 16px 16px;padding:20px 40px;text-align:center">
          <p style="margin:0;font-size:11px;color:#94a3b8">© 2025 Youthnic Exports Pvt. Ltd. — Packing Station</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>
```

---

## 3. Email Address Change

**Subject:** `Confirm your new email — Youthnic Packing Station`

**Message body:** Use the same HTML as #2 above, replacing the heading text with **"Confirm new email"** and the body line with:
> _"Click below to confirm your new email **%NEW_EMAIL%** for your Youthnic account."_

---

## Checklist

- [ ] Firebase Console → Authentication → **Templates** → set Sender name + From (`noreply@youthnic.shop`)
- [ ] Paste HTML for Template 1 (Password reset)
- [ ] Paste HTML for Template 2 (Email verification)
- [ ] Paste HTML for Template 3 (Email change)
- [ ] Send a test (Console → Templates → click the eye icon to preview)
- [ ] Verify deliverability: trigger a "Forgot password" on the live app → check inbox

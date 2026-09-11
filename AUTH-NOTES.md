# EZVIZ cloud API — auth notes

How `ezviz-firmware.js` authenticates against the EZVIZ cloud API. Documented
here so the script is readable; **no credentials belong in this file or in this
repository.**

## Password handling

Two layers, both derived from the plaintext password:

```
md5hex      = md5(password)                              unsalted, lowercase
v6 password = base64( RSA_PKCS1(md5hex + "," + unix_secs) )
v5 password = md5hex                                     bare digest, legacy
```

`v6` wraps the digest together with a **unix timestamp** under the server's RSA
public key. The timestamp means a captured login body cannot be replayed
indefinitely.

The RSA key is fetched at runtime:

```
GET /v3/users/publickey        -> { "publicKey": "<base64 SPKI DER>" }
```

Wrapping is opportunistic — if the key cannot be fetched, the client falls back
to the bare `md5hex` on the legacy endpoint, so login can still succeed.

## Login

```
POST /v3/users/login/v6        form-encoded
POST /v3/users/login/v5        fallback, bare md5hex
```

Form fields:

| field | value |
|---|---|
| `account` | email address |
| `password` | wrapped digest (see above) |
| `featureCode` | 32-hex device fingerprint |
| `msgType` | `0` |
| `redirect` | `0` |
| `zoneOffset` | `0` |
| `bizType`, `smsCode`, `cuName`, `longitude`, `latitude`, `imageCode`, `pushRegisterJson`, `pushExtJson` | empty |

The `/v5` retry is attempted when `/v6` returns no session — either the account
is on the `USER_PWD_NEED_USE_OLD_API` grey list, or the server rejected the
wrapped form.

### `featureCode`

A 32-hex string identifying the client. It is embedded in the session JWT's
`s` claim, so **it must stay constant** across login and every subsequent
request. `ezviz-firmware.js` generates it per run with `crypto.randomBytes(16)`.

## Session

A successful login returns `loginSession.sessionId` plus a region:

```json
{
  "loginSession": { "sessionId": "eyJhbGciOiJIUzM4NCJ9..." },
  "loginArea":    { "apiDomain": "<region host>", "areaId": <n> },
  "loginUser":    { "userId": "..." }
}
```

`sessionId` is a JWT (HS384). **The API host depends on the region** returned at
login — the global host is only an entry point, and the account is routed to a
regional one. Pass `--region <host>` to override.

## Requests

Common headers on every call:

| header | value |
|---|---|
| `sessionId` | from login |
| `clientType` | `3` |
| `osVersion` | `14` |
| `clientVersion` | `7.6.1.0824` |
| `netType` | `WIFI` |
| `customno` | `1000001` |
| `clientNo` | `NodeJS` |
| `appId` | `ys7` |
| `featureCode` | same value as login |
| `User-Agent` | `okhttp/4.9.0` |

## Endpoints used

```
GET  /v3/userdevices/v1/resources/pagelist        ?limit=&offset=
GET  /v3/deviceupgrade/package/checkUpgrade       ?deviceSerial=<serial>
```

Pagination is driven by `page.hasNext`; `resourceInfos[]` holds the devices.
`checkUpgrade` returns `data.list[0]` with `pkg.url`, `pkg.packageMd5`,
`pkg.packageSize`, `pkg.firmwareVersion`, or a non-zero `meta.code`.

## Ownership

`checkUpgrade` returns code **`20002`** for any device the account does not
**own** — this covers both "not bound at all" and "shared to you". Only the
owner may query a device's firmware. `ezviz-firmware.js` reports these as
`not-owned` and moves on; it does not attempt to work around the check.

## Firmware URLs

The download URL is **content-addressed**: its path segment is the file's MD5.

```
https://devupgrade-ali.ys7.com/<md5>/digicap.dav
```

No authentication is required for the download itself, and the hash is verified
against `pkg.packageMd5` after transfer.

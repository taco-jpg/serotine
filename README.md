# Serotine | Zero-Trust P2P Protocol

![Serotine Aesthetic](https://img.shields.io/badge/Architecture-Zero--Trust-black?style=for-the-badge&logo=shield)
![Deployed on Cloudflare](https://img.shields.io/badge/Deployed%20on-Cloudflare-orange?style=for-the-badge&logo=cloudflare)

Serotine is a hyper-minimalist, high-privacy social protocol built on the principle of **Zero-Trust Identity**. It rejects centralized authentication, platform-controlled state, and metadata harvesting.

## 🛡️ Core Principles

- **Identity is a Key Pair**: There is no "registration". Your account is an Ed25519 signing key and an ECDH encryption key generated locally in your browser sandbox.
- **D1 as a Signal Neutral Relay**: Cloudflare D1 is utilized solely as a message relay and WebRTC signaling buffer. It never sees your private keys or unencrypted message content.
- **Ephemeral & Peer-to-Peer**: We prioritize WebRTC DataChannels for direct, low-latency device-to-device communication. D1 acts only as a fallback for offline message delivery.
- **Self-Destructing State**: Messages are retrieved and immediately purged from the server, living only in your local browser storage (IndexedDB).

## ⚡ Tech Stack

- **Framework**: Next.js 15+ (Forced Edge Runtime)
- **Infrastructure**: Cloudflare Pages + Cloudflare D1 (SQLite)
- **Database**: Prisma with D1 Driver Adapter
- **Cryptography**: Web Crypto API (AES-GCM, ECDH, Ed25519)
- **Styling**: Zinc-950 / Vercel Aesthetic (Tailwind CSS)

## 🛠️ Local Development & Deployment

### 1. Prerequisites
Ensure you have the [Cloudflare Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed.

### 2. Database Setup
```bash
# Push schema to local D1 (dev)
npx wrangler d1 migrations apply serotine-db --local

# Push schema to production D1
npx wrangler d1 migrations apply serotine-db --remote
```

### 3. Build & Deploy
This project must be compiled for the Cloudflare Pages environment using `next-on-pages`.

```bash
# Compile for Edge
npx @cloudflare/next-on-pages

# Deploy to Cloudflare
npx wrangler pages deploy .vercel/output/static --project-name v0-serotine
```

## 🔐 Security Audit
The codebase is designed to be "Secure by Absence".
- **No Cookies**: We don't use sessions. Every request is signed.
- **No Passwords**: We use cryptographic challenges.
- **Local Secret Storage**: Your private keys remain in `localStorage` / `IndexedDB` and never touch a network socket.

---
*Built with precision. Zero Trust. Pure Privacy.*

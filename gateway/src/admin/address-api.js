// Admin API for the Domain & SSL page: the gateway's address on the internet (see address.js)
//   GET  /address                      the address, its checks and the steps done
//   POST /address/check                check again now
//   POST /address/caddy   { domain, email }   a server with its own public IP: Caddy and Let's Encrypt
//   POST /address/tunnel  { token, domain }   a Cloudflare Tunnel (made in the Cloudflare dashboard)
//   POST /address/remove               stop using it (devices installed with it can't reach the gateway)
// The tunnel token never comes back, and isn't in the audit log.

import { AddressError } from "../address.js";

export function addressRoutes({ address, store, ApiError }) {
  const guard = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AddressError) throw new ApiError(400, err.message);
      throw err;
    }
  };
  return {
    async "GET /address"() {
      await address.lookupIp();
      return address.view();
    },
    async "POST /address/check"() {
      await address.check();
      return address.view();
    },
    async "POST /address/caddy"({ body, admin, ip }) {
      const view = await guard(() => address.useCaddy({ domain: body.domain, email: body.email }));
      store.audit(admin.username, "address.set", { mode: "caddy", domain: view.domain }, ip);
      return view;
    },
    async "POST /address/tunnel"({ body, admin, ip }) {
      const view = await guard(() => address.useTunnel({ token: body.token, domain: body.domain }));
      store.audit(admin.username, "address.set", { mode: "tunnel", domain: view.domain }, ip);
      return view;
    },
    async "POST /address/remove"({ admin, ip }) {
      const before = address.view();
      const view = await address.remove();
      store.audit(admin.username, "address.removed", { mode: before.mode, domain: before.domain }, ip);
      return view;
    },
  };
}

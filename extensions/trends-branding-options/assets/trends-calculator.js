"use strict";
(() => {
  const b = (u, f) =>
      new Intl.NumberFormat("en-NZ", {
        style: "currency",
        currency: f || "NZD",
      }).format(Number(u || 0)),
    s = (u) => {
      const f = document.createElement("span");
      return ((f.textContent = String(u ?? "")), f.innerHTML);
    },
    I = (u) => {
      if (u.dataset.initialized) return;
      u.dataset.initialized = "true";
      const f = JSON.parse(u.querySelector("[data-trends-data]").textContent),
        r = f.configuration || {},
        $ = f.variants || [],
        v = r.custom_variant_configuration || null,
        M = v !== null && v.enabled !== !0,
        q = v?.enabled
          ? [...(v.options || [])].sort((t, i) =>
              t.key === v.primaryOptionKey
                ? -1
                : i.key === v.primaryOptionKey
                  ? 1
                  : 0,
            )
          : [],
        O = new Map($.map((t) => [String(t.sku || ""), t])),
        x = q.length
          ? (v.variants || [])
              .map((t) => {
                const i = O.get(String(t.sku || ""));
                return i ? { ...i, configured: t } : null;
              })
              .filter(Boolean)
          : [],
        w = x.length > 0,
        L = w
          ? x.find((t) => t.available) || x[0]
          : $.find((t) => t.available) || $[0],
        S = [...(r.quantityBreaks || [])].sort(
          (t, i) => t.quantity - i.quantity,
        ),
        a = {
          variant: L,
          attributes: { ...(L?.configured?.attributes || {}) },
          mode: "unbranded",
          method: null,
          packaging:
            (r.packagingMethods || []).find((t) => t.type === "standard") ||
            null,
          quantity: Number(S[0]?.quantity || 1),
        },
        e = (t) => u.querySelector(t),
        H = (t) => [...u.querySelectorAll(t)],
        P = () =>
          a.mode === "branding"
            ? (r.brandingMethods || []).filter(
                (t) => !t.mode || t.mode === "branding",
              )
            : [],
        A = () =>
          S.filter((t) => a.quantity >= t.quantity).pop() ||
          S[0] || { unitPrice: 0 },
        _ = () => {
          const t = Number(A().unitPrice || 0),
            i = a.mode === "unbranded" ? 0 : Number(a.method?.unitPrice || 0),
            n = a.mode === "unbranded" ? 0 : Number(a.method?.setupPrice || 0),
            o = Number(a.packaging?.unitPrice || 0),
            k = Number(a.packaging?.setupPrice || 0),
            g = n + k,
            p = Number(r.fixedShippingAmount || 0),
            y =
              ((t + i + o) * a.quantity + g + p) *
              (1 + Number(r.markupPercent || 0) / 100);
          return {
            unit: y / a.quantity,
            branding: i,
            packaging: o,
            setup: g,
            shipping: {
              id: "fixed",
              service: "fixed",
              name: "Fixed shipping and handling",
            },
            shippingCharge: p,
            subtotal: y,
          };
        },
        B = () => {
          const t = e("[data-variant-step]");
          if ((t && (t.hidden = M), M)) {
            e("[data-variant-options]").innerHTML = "";
            return;
          }
          if (
            (e("[data-variant-options]").classList.toggle(
              "trends-configured-options",
              w,
            ),
            !w)
          ) {
            e("[data-variant-options]").innerHTML = $.map(
              (n) =>
                `<button type="button" class="trends-pill ${n.id === a.variant?.id ? "is-active" : ""}" data-variant-id="${n.id}" ${n.available ? "" : "disabled"}>${s(n.title)}</button>`,
            ).join("");
            return;
          }
          ((e("[data-variant-heading]").textContent = "Choose your options"),
            (e("[data-summary-variant-label]").textContent = "Selection"));
          const i = q
            .map((n, o) => {
              const k = q.slice(0, o),
                g = x.filter((c) =>
                  k.every((d) => {
                    const m = a.attributes[d.name];
                    return !m || c.configured.attributes?.[d.name] === m;
                  }),
                ),
                p = [
                  ...new Set(
                    g
                      .map((c) => c.configured.attributes?.[n.name])
                      .filter(Boolean),
                  ),
                ];
              if (!p.length) return "";
              const y = p
                .map((c) => {
                  const d = g.some(
                      (h) =>
                        h.available && h.configured.attributes?.[n.name] === c,
                    ),
                    m = n.displayValues?.[c] || c;
                  return `<button type="button" class="trends-pill ${a.attributes[n.name] === c ? "is-active" : ""}" data-configured-option="${s(n.key)}" data-configured-value="${s(c)}" ${d ? "" : "disabled"}>${s(m)}</button>`;
                })
                .join("");
              return `<div class="trends-configured-option"><h4>${s(n.name)}</h4><div class="trends-choice-grid">${y}</div></div>`;
            })
            .join("");
          e("[data-variant-options]").innerHTML = i;
        },
        F = () => {
          for (const t of ["branding"]) {
            const i = e(`[data-mode="${t}"]`),
              n = (r.brandingMethods || []).filter(
                (o) => !o.mode || o.mode === "branding",
              );
            i.hidden = !n.length;
          }
          H("[data-mode]").forEach((t) =>
            t.classList.toggle("is-active", t.dataset.mode === a.mode),
          );
        },
        J = () => {
          const t = P();
          (t.some((i) => i.id === a.method?.id) || (a.method = t[0] || null),
            (e("[data-branding-step]").hidden = a.mode === "unbranded"),
            (e("[data-quantity-step]").textContent = "4"),
            (e("[data-method-options]").innerHTML = t
              .map(
                (i) =>
                  `<button type="button" class="trends-method ${i.id === a.method?.id ? "is-active" : ""}" data-method-id="${s(i.id)}"><strong>${s(i.name)}</strong><small>${s(i.area || i.description)}</small><span>From ${b(i.unitPrice, r.currency)} / unit</span></button>`,
              )
              .join("")),
            (e("[data-price-table]").innerHTML = ""));
        },
        Q = () => {
          const t = r.packagingMethods || [],
            i = e("[data-packaging-options]");
          ((e("[data-packaging-step]").hidden = !t.length),
            i &&
              (a.packaging &&
                !t.some((n) => n.id === a.packaging.id) &&
                (a.packaging = null),
              (i.innerHTML = t
                .map((n) => {
                  const o = n.included
                    ? "Included"
                    : n.action === "request_quote"
                      ? "Request quote"
                      : `+${b(n.unitPrice, r.currency)} each${Number(n.setupPrice || 0) > 0 ? ` + ${b(n.setupPrice, r.currency)} setup` : ""}`;
                  return `<button type="button" class="trends-method ${n.id === a.packaging?.id ? "is-active" : ""}" data-packaging-id="${s(n.id)}"><strong>${s(n.name)}</strong><small>${s(n.description || "")}</small><em>${s(o)}</em></button>`;
                })
                .join(""))));
        },
        j = () => {
          ((e("[data-quantity-options]").innerHTML = S.map(
            (t) =>
              `<button type="button" class="trends-pill ${t.quantity === a.quantity ? "is-active" : ""}" data-quantity="${t.quantity}">${t.quantity}</button>`,
          ).join("")),
            (e("[data-custom-quantity]").value = a.quantity));
        },
        T = () => {
          const t = _();
          ((e("[data-summary-variant]").textContent =
            a.variant?.title || "\u2014"),
            (e("[data-summary-mode]").textContent =
              a.mode === "unbranded"
                ? "Unbranded"
                : a.method?.name || "\u2014"),
            (e("[data-summary-quantity]").textContent = a.quantity),
            (e("[data-summary-unit]").textContent = b(t.unit, r.currency)),
            (e("[data-summary-branding]").textContent = b(
              t.branding,
              r.currency,
            )),
            (e("[data-summary-additional-label]").textContent =
              a.mode === "gift_ready" ? "Packaging / unit" : "Branding / unit"),
            (e("[data-summary-setup]").textContent = b(t.setup, r.currency)),
            (e("[data-summary-shipping]").textContent = b(
              t.shippingCharge,
              r.currency,
            )),
            (e("[data-summary-subtotal]").textContent = b(
              t.subtotal,
              r.currency,
            )),
            (e("[data-summary-branding-row]").hidden = a.mode === "unbranded"),
            (e("[data-summary-packaging-row]").hidden = !a.packaging),
            (e("[data-summary-packaging]").textContent =
              a.packaging?.name || "\u2014"),
            (e("[data-summary-setup-row]").hidden =
              a.mode === "unbranded" || t.setup <= 0),
            (e("[data-summary-shipping-row]").hidden = !t.shipping),
            (e("[data-add-to-cart]").disabled =
              !a.variant || a.packaging?.action === "request_quote"),
            (e("[data-add-to-cart]").textContent =
              a.packaging?.action === "request_quote"
                ? "Request a quote"
                : "Add selection to cart"));
        },
        E = () => {
          (B(), F(), J(), Q(), j(), T());
        };
      (u.addEventListener("click", async (t) => {
        const i = t.target.closest("[data-variant-id]"),
          n = t.target.closest("[data-configured-option]"),
          o = t.target.closest("[data-mode]"),
          k = t.target.closest("[data-method-id]"),
          g = t.target.closest("[data-packaging-id]"),
          p = t.target.closest("[data-quantity]");
        if (
          (i &&
            (a.variant = $.find((d) => String(d.id) === i.dataset.variantId)),
          n)
        ) {
          const d = q.findIndex((l) => l.key === n.dataset.configuredOption),
            m = q[d],
            h = {};
          (q.slice(0, d).forEach((l) => {
            a.attributes[l.name] && (h[l.name] = a.attributes[l.name]);
          }),
            (h[m.name] = n.dataset.configuredValue));
          const C = x.find(
            (l) =>
              l.available &&
              Object.entries(h).every(
                ([V, z]) => l.configured.attributes?.[V] === z,
              ),
          );
          C &&
            ((a.variant = C),
            (a.attributes = { ...(C.configured.attributes || {}) }));
        }
        if (
          (o && (a.mode = o.dataset.mode),
          k && (a.method = P().find((d) => d.id === k.dataset.methodId)),
          g &&
            (a.packaging = (r.packagingMethods || []).find(
              (d) => d.id === g.dataset.packagingId,
            )),
          p && (a.quantity = Number(p.dataset.quantity)),
          i || n || o || k || g || p)
        )
          return E();
        if (!t.target.closest("[data-add-to-cart]")) return;
        const y = e("[data-add-to-cart]"),
          c = e("[data-feedback]");
        ((y.disabled = !0), (y.textContent = "Adding\u2026"));
        try {
          const d = await fetch(
              `${window.Shopify?.routes?.root || "/"}apps/trends/configuration-variant`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  variantId: a.variant.id,
                  variantSku: a.variant.sku,
                  quantity: a.quantity,
                  service: a.mode,
                  brandingId: (a.mode === "branding" && a.method?.id) || null,
                  brandingQuantity: a.mode === "branding" ? a.quantity : null,
                  packagingId:
                    (["premium", "custom"].includes(a.packaging?.type) &&
                      a.packaging.methodId) ||
                    null,
                  packagingQuantity: ["premium", "custom"].includes(
                    a.packaging?.type,
                  )
                    ? a.quantity
                    : null,
                  shippingService: null,
                }),
              },
            ),
            m = await d.json();
          if (!d.ok || !m.ok)
            throw new Error(
              m.message || "Could not prepare this configuration",
            );
          const h = [
              {
                id: Number(m.numericVariantId),
                quantity: m.cartQuantity || 1,
                properties: m.properties || {},
              },
            ],
            C = await fetch(
              `${window.Shopify?.routes?.root || "/"}cart/add.js`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ items: h }),
              },
            ),
            l = await C.json();
          if (!C.ok)
            throw new Error(l.description || "Could not add this selection");
          ((c.textContent = "Selection added to cart."),
            document.dispatchEvent(
              new CustomEvent("cart:refresh", { bubbles: !0 }),
            ));
        } catch (d) {
          c.textContent = d.message;
        } finally {
          ((y.disabled = !1), (y.textContent = "Add selection to cart"));
        }
      }),
        e("[data-custom-quantity]").addEventListener("input", (t) => {
          ((a.quantity = Math.max(1, Math.trunc(Number(t.target.value) || 1))),
            j(),
            T());
        }),
        E());
    },
    N = () => document.querySelectorAll("[data-trends-calculator]").forEach(I);
  for (const u of ["DOMContentLoaded", "shopify:section:load"])
    document.addEventListener(u, N);
  N();
})();

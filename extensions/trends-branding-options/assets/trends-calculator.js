(() => {
  const money=(value,currency)=>new Intl.NumberFormat("en-NZ",{style:"currency",currency:currency||"NZD"}).format(Number(value||0));
  const escapeHtml=(value)=>{const node=document.createElement("span");node.textContent=String(value??"");return node.innerHTML};

  const init = (root) => {
    if (root.dataset.initialized) return;
    root.dataset.initialized = "true";
    const payload=JSON.parse(root.querySelector("[data-trends-data]").textContent);
    const config = payload.configuration || {};
    const variants = payload.variants || [];
    const breaks = [...(config.quantityBreaks || [])].sort(
      (first, second) => first.quantity - second.quantity,
    );
    const state = {
      variant: variants.find((variant) => variant.available) || variants[0],
      mode: "unbranded",
      method: null,
      quantity: Number(breaks[0]?.quantity || 1),
    };
    const find=(selector)=>root.querySelector(selector),findAll=(selector)=>[...root.querySelectorAll(selector)];

    const methodsForMode = () =>
      (config.brandingMethods || []).filter(
        (method) => method.mode === state.mode,
      );
    const activeBreak = () =>
      breaks.filter((price) => state.quantity >= price.quantity).pop() ||
      breaks[0] || { unitPrice: 0 };
    const selection = () => {
      const unit = Number(activeBreak().unitPrice || 0);
      const branding =
        state.mode === "unbranded" ? 0 : Number(state.method?.unitPrice || 0);
      const setup =
        state.mode === "unbranded" ? 0 : Number(state.method?.setupPrice || 0);
      const subtotal = (unit + branding) * state.quantity + setup;
      const gst = config.excludesGst
        ? subtotal * Number(config.gstRate || 0)
        : 0;
      return { unit, branding, setup, subtotal, gst, total: subtotal + gst };
    };

    const renderVariants = () => {
      find("[data-variant-options]").innerHTML = variants
        .map(
          (variant) =>
            `<button type="button" class="trends-pill ${variant.id === state.variant?.id ? "is-active" : ""}" data-variant-id="${variant.id}" ${variant.available ? "" : "disabled"}>${escapeHtml(variant.title)}</button>`,
        )
        .join("");
    };

    const renderModes = () => {
      for (const mode of ["branding", "gift_ready"]) {
        const button = find(`[data-mode="${mode}"]`);
        button.hidden = !(config.brandingMethods || []).some(
          (method) => method.mode === mode,
        );
      }
      findAll("[data-mode]").forEach((button) =>
        button.classList.toggle(
          "is-active",
          button.dataset.mode === state.mode,
        ),
      );
    };

    const renderMethods = () => {
      const methods = methodsForMode();
      if (!methods.some((method) => method.id === state.method?.id))
        state.method = methods[0] || null;
      find("[data-branding-step]").hidden = state.mode === "unbranded";
      find("[data-quantity-step]").textContent =
        state.mode === "unbranded" ? "3" : "4";
      find("[data-method-options]").innerHTML = methods
        .map(
          (method) =>
            `<button type="button" class="trends-method ${method.id === state.method?.id ? "is-active" : ""}" data-method-id="${escapeHtml(method.id)}"><strong>${escapeHtml(method.name)}</strong><small>${escapeHtml(method.area || method.description)}</small><span>From ${money(method.unitPrice, config.currency)} / unit</span></button>`,
        )
        .join("");
      const columns = breaks
        .map((price) => `<th>${price.quantity}</th>`)
        .join("");
      const rows = methods
        .map(
          (method) =>
            `<tr><th>${escapeHtml(method.name)}</th>${breaks
              .map(
                (price) =>
                  `<td>${money(Number(price.unitPrice) + Number(method.unitPrice), config.currency)}</td>`,
              )
              .join(
                "",
              )}</tr><tr class="trends-setup-row"><th>Setup fee</th><td colspan="${Math.max(1, breaks.length)}">${money(method.setupPrice, config.currency)}</td></tr>`,
        )
        .join("");
      find("[data-price-table]").innerHTML = methods.length
        ? `<table><thead><tr><th>Quantity</th>${columns}</tr></thead><tbody>${rows}</tbody></table>`
        : "";
    };

    const renderQuantities = () => {
      find("[data-quantity-options]").innerHTML = breaks
        .map(
          (price) =>
            `<button type="button" class="trends-pill ${price.quantity === state.quantity ? "is-active" : ""}" data-quantity="${price.quantity}">${price.quantity}</button>`,
        )
        .join("");
      find("[data-custom-quantity]").value = state.quantity;
    };

    const renderInformation = () => {
      const specs = config.specifications || [];
      find("[data-product-information]").innerHTML = `
        <details open><summary>Product details & specifications</summary>
          ${config.packaging ? `<p><strong>Packaging:</strong> ${escapeHtml(config.packaging)}</p>` : ""}
          <dl>${specs.map((item) => `<div><dt>${escapeHtml(item.specification)}</dt><dd>${escapeHtml(item.description)}</dd></div>`).join("")}</dl>
        </details>`;
    };

    const renderSummary = () => {
      const totals = selection();
      find("[data-summary-variant]").textContent = state.variant?.title || "—";
      find("[data-summary-mode]").textContent =
        state.mode === "unbranded" ? "Unbranded" : state.method?.name || "—";
      find("[data-summary-quantity]").textContent = state.quantity;
      find("[data-summary-unit]").textContent = money(
        totals.unit,
        config.currency,
      );
      find("[data-summary-branding]").textContent = money(
        totals.branding,
        config.currency,
      );
      find("[data-summary-setup]").textContent = money(
        totals.setup,
        config.currency,
      );
      find("[data-summary-subtotal]").textContent = money(
        totals.subtotal,
        config.currency,
      );
      find("[data-summary-gst]").textContent = money(
        totals.gst,
        config.currency,
      );
      find("[data-summary-total]").textContent = money(
        totals.total,
        config.currency,
      );
      find("[data-summary-branding-row]").hidden = state.mode === "unbranded";
      find("[data-summary-setup-row]").hidden =
        state.mode === "unbranded" || totals.setup <= 0;
      find("[data-add-to-cart]").disabled =
        !state.variant ||
        (state.mode !== "unbranded" && !state.method?.unitVariantId);
    };

    const render = () => {
      renderVariants();
      renderModes();
      renderMethods();
      renderQuantities();
      renderSummary();
    };

    root.addEventListener("click", async (event) => {
      const variant = event.target.closest("[data-variant-id]");
      const mode = event.target.closest("[data-mode]");
      const method = event.target.closest("[data-method-id]");
      const quantity = event.target.closest("[data-quantity]");
      if (variant)
        state.variant = variants.find(
          (item) => String(item.id) === variant.dataset.variantId,
        );
      if (mode) state.mode = mode.dataset.mode;
      if (method)
        state.method = methodsForMode().find(
          (item) => item.id === method.dataset.methodId,
        );
      if (quantity) state.quantity = Number(quantity.dataset.quantity);
      if (variant || mode || method || quantity) return render();
      if (!event.target.closest("[data-add-to-cart]")) return;

      const button = find("[data-add-to-cart]");
      const feedback = find("[data-feedback]");
      button.disabled = true;
      button.textContent = "Adding…";
      const items = [
        {
          id: Number(state.variant.id),
          quantity: state.quantity,
          properties: {
            "Product service":
              state.mode === "unbranded" ? "Unbranded" : state.method.name,
          },
        },
      ];
      if (state.mode !== "unbranded" && state.method?.unitVariantId) {
        items.push({
          id: Number(String(state.method.unitVariantId).split("/").pop()),
          quantity: state.quantity,
          properties: {
            "For product": config.productCode,
            "Charge type": "Per unit",
          },
        });
        if (state.method.setupVariantId && Number(state.method.setupPrice) > 0)
          items.push({
            id: Number(String(state.method.setupVariantId).split("/").pop()),
            quantity: 1,
            properties: {
              "For product": config.productCode,
              "Charge type": "Setup fee",
            },
          });
      }
      try {
        const response = await fetch(
          `${window.Shopify?.routes?.root || "/"}cart/add.js`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ items }),
          },
        );
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.description || "Could not add this selection");
        feedback.textContent = "Selection added to cart.";
        document.dispatchEvent(
          new CustomEvent("cart:refresh", { bubbles: true }),
        );
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        button.disabled = false;
        button.textContent = "Add selection to cart";
      }
    });

    find("[data-custom-quantity]").addEventListener("input", (event) => {
      state.quantity = Math.max(1, Math.trunc(Number(event.target.value) || 1));
      renderQuantities();
      renderSummary();
    });
    renderInformation();render();
  };

  const initialize=()=>document.querySelectorAll("[data-trends-calculator]").forEach(init);
  for(const event of ["DOMContentLoaded","shopify:section:load"])document.addEventListener(event,initialize);
  initialize();
})();

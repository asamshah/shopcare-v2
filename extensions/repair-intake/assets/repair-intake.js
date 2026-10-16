// Repair request — a step-by-step form (snippets/shopcare_request_form).
//   1. the product. Logged out: log in, or continue without an account.
//      Logged in: their profile and products, each with its cover; an item
//      with a repair already open can't be chosen. Anyone can find a product
//      by name or SKU (the catalogue) or by order number (guests verify the
//      order with its email), or describe it.
//   2. describe the issue, add photos
//   3. contact details → submit → confirmation with a status tracker
// Submits a multipart request to the signed App Proxy. The customer is Shopify's
// logged_in_customer_id or the signed token Liquid put on the proxy URLs, and
// the server re-verifies whichever item was chosen.
// Also opens/closes the app-embed dialog.
(function () {
  if (window.ShopCareRequestForm) return; // the block and the embed may both load this
  window.ShopCareRequestForm = true;

  var PAGE_SIZE = 6;
  var MIN_SEARCH = 2;
  var SEARCH_DELAY = 250;
  var ORDER_NUMBER = /^#?\s*[A-Za-z]{0,4}-?\d{3,}$/; // "1042", "#1042", "#LX-1042"

  function init(root) {
    var loggedIn = root.getAttribute("data-logged-in") === "true";
    var maxImages = parseInt(root.getAttribute("data-max-images"), 10) || 6;
    var urls = {
      intake: root.getAttribute("data-intake-url") || "/apps/repairs/intake",
      orders: root.getAttribute("data-orders-url") || "/apps/repairs/orders",
      catalog: root.getAttribute("data-catalog-url") || "/apps/repairs/catalog_search",
      lookup: root.getAttribute("data-lookup-url") || "/apps/repairs/order_lookup"
    };

    var form = root.querySelector("[data-repair-form]");
    if (!form) return;
    function $(selector) { return root.querySelector(selector); }

    var statusEl = $("[data-repair-status]");
    var confirmation = $("[data-confirmation]");
    var stepper = $("[data-stepper]");
    var panels = Array.prototype.slice.call(root.querySelectorAll("[data-step]"));
    var indicators = Array.prototype.slice.call(root.querySelectorAll("[data-step-indicator]"));
    var imagesInput = $("[data-repair-images]");

    var start = $("[data-start]");
    var history = $("[data-history]");
    var find = $("[data-find]");
    var findInput = $("[data-find-input]");
    var findList = $("[data-find-list]");
    var findCount = $("[data-find-count]");
    var lookup = $("[data-lookup]");
    var lookupEmail = $("[data-lookup-email]");
    var lookupGrid = $("[data-lookup-grid]");
    var selected = $("[data-selected]");
    var variantPick = $("[data-variant-pick]");
    var variantSelect = $("[data-variant-select]");
    var manualFields = $("[data-manual-fields]");
    var step1Actions = $('[data-step="1"] .repair-intake__actions');

    var hidden = {
      productId: $("[data-h-product-id]"),
      variantId: $("[data-h-variant-id]"),
      productTitle: $("[data-h-product-title]"),
      variantTitle: $("[data-h-variant-title]"),
      orderNumber: $("[data-h-order-number]"),
      orderDate: $("[data-h-order-date]"),
      noHistory: $("[data-h-no-history]"),
      itemId: $("[data-h-item-id]"),
      orderId: $("[data-h-order-id]"),
      orderLineId: $("[data-h-order-line-id]"),
      orderToken: $("[data-h-order-token]"),
      unverified: $("[data-h-unverified]")
    };
    var manual = {
      productTitle: $("[data-f-product-title]"),
      orderNumber: $("[data-f-order-number]"),
      noHistory: $("[data-f-no-history]")
    };

    var mode = "none"; // "history" | "lookup" | "catalog" | "manual"
    var guestChosen = false; // a guest chose "Continue without an account"
    var current = 1;

    function show(node) { if (node) node.hidden = false; }
    function hide(node) { if (node) node.hidden = true; }
    function field(name) { return form.querySelector('[name="' + name + '"]'); }
    function el(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }

    function setStatus(message, isError) {
      if (!statusEl) return;
      statusEl.hidden = !message;
      statusEl.textContent = message || "";
      statusEl.classList.toggle("repair-intake__status--error", !!isError);
      statusEl.classList.toggle("repair-intake__status--ok", !!message && !isError);
    }

    function goTo(step) {
      current = step;
      panels.forEach(function (p) { p.hidden = parseInt(p.getAttribute("data-step"), 10) !== step; });
      indicators.forEach(function (i) {
        i.classList.toggle("is-active", parseInt(i.getAttribute("data-step-indicator"), 10) <= step);
      });
      setStatus("");
    }

    function formatDate(value) {
      if (!value) return "";
      var d = new Date(value);
      return isNaN(d) ? "" : d.toLocaleDateString();
    }

    function productLabel(p) {
      return p.variant_title ? p.product_title + " — " + p.variant_title : p.product_title;
    }

    function orderLine(p) {
      return [p.order_name, formatDate(p.order_date)].filter(Boolean).join(" · ");
    }

    // "Covered until 12/03/2028" (Care), "Until 12/03/2027" (warranty).
    function coverDetail(cover) {
      return (cover.kind === "care" ? "Covered until " : "Until ") + formatDate(cover.ends_at);
    }

    // The badge the server sends: "ShopCare – 2 year plan" (Care), "12-month warranty".
    function coverBadge(cover) {
      return cover ? cover.badge || cover.name : "No cover";
    }

    // "ShopCare – 2 year plan · Covered until 12/03/2028", or "No cover".
    function coverText(cover) {
      return cover ? coverBadge(cover) + " · " + coverDetail(cover) : "No cover";
    }

    function ticketText(ticket) {
      return ticket.status === "new" ? "Repair requested" : "Repair in progress (" + ticket.status_label + ")";
    }

    // While choosing: the guest's start choice (no "Next" until they make it),
    // or their products and the search.
    function browsing(visible) {
      if (history) history.hidden = !visible;
      if (start) start.hidden = !visible || guestChosen;
      if (find) find.hidden = !visible || (!loggedIn && !guestChosen);
      step1Actions.hidden = !!start && !start.hidden;
    }

    // ── The chosen product ────────────────────────────────────────────────
    function clearHidden() {
      Object.keys(hidden).forEach(function (k) { if (hidden[k]) hidden[k].value = ""; });
      hidden.noHistory.value = "false";
      hidden.unverified.value = "false";
    }

    // source: "history" | "lookup" | "catalog". `token`: a guest's verified order.
    function selectProduct(p, source, token) {
      mode = source;
      clearHidden();
      hidden.productId.value = p.product_id || "";
      hidden.variantId.value = p.variant_id || "";
      hidden.productTitle.value = p.product_title || "";
      hidden.variantTitle.value = p.variant_title || "";
      hidden.orderNumber.value = p.order_name || "";
      hidden.orderDate.value = p.order_date || "";
      if (source === "catalog") {
        hidden.unverified.value = "true";
      } else if (token) {
        hidden.orderToken.value = token;
        hidden.orderLineId.value = p.order_line_id || "";
      } else {
        hidden.itemId.value = p.item_id || "";
        hidden.orderId.value = p.order_id || "";
        hidden.orderLineId.value = p.order_line_id || "";
      }

      var img = selected.querySelector("[data-selected-image]");
      img.src = p.image_url || "";
      img.alt = p.product_title || "";
      img.hidden = !p.image_url;
      selected.querySelector("[data-selected-title]").textContent = productLabel(p);
      selected.querySelector("[data-selected-order]").textContent =
        source === "catalog" ? (p.sku ? "SKU " + p.sku : "From our catalogue") : orderLine(p);
      var cov = selected.querySelector("[data-selected-cover]");
      cov.textContent = coverText(p.cover);
      cov.hidden = source === "catalog";
      var note = selected.querySelector("[data-selected-cover-note]");
      note.textContent = (p.cover && p.cover.statutory_rights) || "";
      note.hidden = !note.textContent;
      showVariants(p.variants);

      show(selected);
      hide(manualFields);
      browsing(false);
      setStatus("");
    }

    // A catalogue product with several variants: optionally say which one.
    function showVariants(variants) {
      variantSelect.innerHTML = "";
      if (!variants || !variants.length) { hide(variantPick); return; }
      variantSelect.appendChild(el("option", "", "Not sure"));
      variants.forEach(function (v) {
        var option = el("option", "", v.variant_title || v.sku || "");
        option.value = v.variant_id;
        variantSelect.appendChild(option);
      });
      show(variantPick);
    }

    variantSelect.addEventListener("change", function () {
      var option = variantSelect.options[variantSelect.selectedIndex];
      hidden.variantId.value = option.value || "";
      hidden.variantTitle.value = option.value ? option.textContent : "";
    });

    function useManual() {
      mode = "manual";
      clearHidden();
      hide(selected);
      show(manualFields);
      browsing(false);
      setStatus("");
    }

    function changeProduct() {
      clearHidden();
      mode = "none";
      hide(selected);
      hide(manualFields);
      browsing(true);
    }

    // ── Product cards: purchases, and the lines of a looked-up order ───────
    function card(p, onPick) {
      var button = el("button", "repair-intake__card");
      button.type = "button";
      if (p.image_url) {
        var img = el("img", "repair-intake__card-img");
        img.src = p.image_url;
        img.alt = "";
        img.loading = "lazy";
        button.appendChild(img);
      }
      button.appendChild(el("span", "repair-intake__card-title", productLabel(p)));
      button.appendChild(el("span", "repair-intake__card-sub", orderLine(p)));
      button.appendChild(el("span", "repair-intake__badge repair-intake__badge--" + (p.cover ? p.cover.kind : "none"), coverBadge(p.cover)));
      if (p.cover) button.appendChild(el("span", "repair-intake__card-sub", coverDetail(p.cover)));
      if (p.open_ticket) {
        button.appendChild(el("span", "repair-intake__badge repair-intake__badge--open", ticketText(p.open_ticket)));
        button.setAttribute("aria-disabled", "true");
      }
      button.addEventListener("click", function () {
        if (!p.open_ticket) { onPick(p); return; }
        setStatus("A repair is already open for " + productLabel(p) + ". We'll be in touch about it.", true);
      });
      return button;
    }

    // Shows the first PAGE_SIZE cards; "Show more" adds the next page.
    function renderCards(grid, products, onPick, more) {
      var shown = 0;
      function page() {
        products.slice(shown, shown + PAGE_SIZE).forEach(function (p) { grid.appendChild(card(p, onPick)); });
        shown = Math.min(shown + PAGE_SIZE, products.length);
        if (more) more.hidden = shown >= products.length;
      }
      grid.innerHTML = "";
      if (more) more.onclick = page;
      page();
      grid.hidden = !products.length;
    }

    // The logged-in customer's products (none for guests); the orders URL
    // carries their signed token from Liquid.
    function loadItems() {
      if (!loggedIn || !history) return;
      var loading = $("[data-history-loading]");
      var empty = $("[data-history-empty]");
      fetch(urls.orders, { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var products = (data && data.ok && data.products) || [];
          hide(loading);
          empty.hidden = products.length > 0;
          renderCards($("[data-history-grid]"), products, function (p) { selectProduct(p, "history"); }, $("[data-history-more]"));
        })
        .catch(function () { hide(loading); show(empty); });
    }

    // ── Find the product you bought: a combobox over the catalogue ─────────
    var searchTimer = null;
    var searchSeq = 0;
    var options = [];
    var active = -1;
    var orderTerm = "";

    function closeList() {
      options = [];
      active = -1;
      findList.innerHTML = "";
      hide(findList);
      findInput.setAttribute("aria-expanded", "false");
      findInput.removeAttribute("aria-activedescendant");
    }

    function setActive(index) {
      active = index;
      options.forEach(function (o, i) { o.node.setAttribute("aria-selected", i === index ? "true" : "false"); });
      if (index >= 0) findInput.setAttribute("aria-activedescendant", options[index].node.id);
      else findInput.removeAttribute("aria-activedescendant");
    }

    function renderOptions(term, results) {
      closeList();
      if (ORDER_NUMBER.test(term)) {
        options.push({ label: "Find order " + (term.charAt(0) === "#" ? term : "#" + term), pick: function () { chooseOrder(term); } });
      }
      results.forEach(function (r) {
        options.push({ label: productLabel(r) + (r.sku ? " · " + r.sku : ""), image: r.image_url,
          pick: function () { closeList(); selectProduct(r, "catalog"); } });
      });
      options.forEach(function (o, i) {
        var li = el("li", "repair-intake__option");
        li.id = findList.id + "-" + i;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", "false");
        if (o.image) {
          var img = el("img", "repair-intake__option-img");
          img.src = o.image;
          img.alt = "";
          li.appendChild(img);
        }
        li.appendChild(el("span", "", o.label));
        li.addEventListener("mousedown", function (e) { e.preventDefault(); }); // keep focus in the input
        li.addEventListener("click", function () { o.pick(); });
        o.node = li;
        findList.appendChild(li);
      });
      findList.hidden = !options.length;
      findInput.setAttribute("aria-expanded", options.length ? "true" : "false");
      findCount.textContent = results.length ? results.length + (results.length === 1 ? " product found." : " products found.")
        : (options.length ? "" : "No matching products. Try another name, or describe it instead.");
    }

    function search(term) {
      var seq = ++searchSeq;
      fetch(urls.catalog + "?q=" + encodeURIComponent(term), { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (seq !== searchSeq) return; // a newer search is on its way
          if (data && data.ok === false && data.error) setStatus(data.error, true);
          renderOptions(term, (data && data.results) || []);
        })
        .catch(function () { if (seq === searchSeq) renderOptions(term, []); });
    }

    function chooseOrder(term) {
      closeList();
      orderTerm = term.replace(/^#\s*/, "");
      var label = $("[data-lookup-order]");
      if (label) label.textContent = "#" + orderTerm;
      if (loggedIn) { lookupOrder(); return; }
      show(lookup);
      lookupEmail.focus();
    }

    // Guests: the order number and the email on the order must both match.
    // Logged in: only the customer's own orders (the server checks).
    function lookupOrder() {
      var email = lookupEmail ? lookupEmail.value.trim() : "";
      if (!loggedIn && !email) { setStatus("Enter the email address you used for the order.", true); return; }
      var body = new FormData();
      body.append("order_number", orderTerm);
      if (!loggedIn) body.append("email", email);
      setStatus("Looking for your order…");
      fetch(urls.lookup, { method: "POST", body: body, headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || !data.ok) {
            hide(lookupGrid);
            setStatus((data && data.error) || "We couldn't find that order.", true);
            return;
          }
          setStatus("");
          hide(lookup);
          renderCards(lookupGrid, data.products || [], function (p) { selectProduct(p, "lookup", data.order_token); });
        })
        .catch(function () { setStatus("Couldn't reach the server. Please try again.", true); });
    }

    findInput.addEventListener("input", function () {
      var term = findInput.value.trim();
      clearTimeout(searchTimer);
      hide(lookup);
      if (term.length < MIN_SEARCH) { searchSeq++; closeList(); findCount.textContent = ""; return; }
      searchTimer = setTimeout(function () { search(term); }, SEARCH_DELAY);
    });
    findInput.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!options.length) return;
        e.preventDefault();
        setActive((active + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
      } else if (e.key === "Enter") {
        e.preventDefault(); // never submits the form
        if (active >= 0) options[active].pick();
      } else if (e.key === "Escape") {
        closeList();
      }
    });
    findInput.addEventListener("blur", function () { setTimeout(closeList, 150); });

    $("[data-lookup-submit]").addEventListener("click", lookupOrder);
    if (lookupEmail) {
      lookupEmail.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); lookupOrder(); }
      });
    }

    // Guests start with a choice: log in (a plain link back to this page), or carry on.
    var continueGuest = $("[data-continue-guest]");
    if (continueGuest) {
      continueGuest.addEventListener("click", function () {
        guestChosen = true;
        browsing(true);
        findInput.focus();
      });
    }

    // ── Steps and submit ───────────────────────────────────────────────────
    function syncManual() {
      if (mode !== "manual") return;
      hidden.productTitle.value = (manual.productTitle && manual.productTitle.value.trim()) || "";
      hidden.orderNumber.value = (manual.orderNumber && manual.orderNumber.value.trim()) || "";
      hidden.noHistory.value = manual.noHistory && manual.noHistory.checked ? "true" : "false";
    }

    function validateStep1() {
      if (mode === "manual") {
        if (manual.productTitle && manual.productTitle.value.trim()) return true;
        setStatus("Please enter which item needs repairing.", true);
        return false;
      }
      if (mode !== "none" && (hidden.productId.value || hidden.itemId.value || hidden.orderLineId.value)) return true;
      setStatus("Please choose the product that needs repairing, or describe it.", true);
      return false;
    }

    function validateStep2() {
      var desc = field("description");
      if (desc && desc.value.trim()) return true;
      setStatus("Please describe the issue.", true);
      return false;
    }

    function confirmed(ticketId) {
      hide(form);
      if (stepper) hide(stepper);
      setStatus("");
      $("[data-confirmation-ref]").textContent = ticketId ? "Your reference: #" + ticketId : "";
      show(confirmation);
      confirmation.focus();
    }

    function submit() {
      syncManual();
      var email = field("customer_email");
      if (!email || !email.value.trim()) { setStatus("Please enter your email.", true); return; }

      var btn = form.querySelector("[data-repair-submit]");
      if (btn) btn.disabled = true;
      setStatus("Sending your request…");

      fetch(urls.intake, { method: "POST", body: new FormData(form), headers: { Accept: "application/json" } })
        .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, body: data }; }); })
        .then(function (res) {
          if (res.ok && res.body && res.body.ok) {
            confirmed(res.body.ticket_id);
          } else {
            var errors = (res.body && res.body.errors) || [];
            setStatus(errors.length ? errors.join(" ") : "Something went wrong. Please try again.", true);
          }
        })
        .catch(function () { setStatus("Couldn't reach the server. Please try again.", true); })
        .finally(function () { if (btn) btn.disabled = false; });
    }

    root.querySelectorAll("[data-next]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (current === 1 && !validateStep1()) return;
        if (current === 2 && !validateStep2()) return;
        goTo(parseInt(b.getAttribute("data-next"), 10));
      });
    });
    root.querySelectorAll("[data-back]").forEach(function (b) {
      b.addEventListener("click", function () { goTo(parseInt(b.getAttribute("data-back"), 10)); });
    });

    $("[data-manual-link]").addEventListener("click", useManual);
    $("[data-change-product]").addEventListener("click", changeProduct);

    if (imagesInput) {
      imagesInput.addEventListener("change", function () {
        if (imagesInput.files.length > maxImages) {
          setStatus("Please select no more than " + maxImages + " photos.", true);
          imagesInput.value = "";
        } else {
          setStatus("");
        }
      });
    }

    form.addEventListener("submit", function (event) { event.preventDefault(); submit(); });

    goTo(1);
    browsing(true);
    loadItems();
  }

  // App embed: the floating button opens the form in a dialog.
  function initLauncher(launcher) {
    var dialog = launcher.querySelector("[data-launcher-dialog]");
    launcher.querySelector("[data-launcher-open]").addEventListener("click", function () {
      if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
    });
    launcher.querySelector("[data-launcher-close]").addEventListener("click", function () {
      if (dialog.close) dialog.close(); else dialog.removeAttribute("open");
    });
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog && dialog.close) dialog.close(); // click on the backdrop
    });
  }

  function start() {
    document.querySelectorAll("[data-repair-intake]").forEach(init);
    document.querySelectorAll("[data-shopcare-launcher]").forEach(initLauncher);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();

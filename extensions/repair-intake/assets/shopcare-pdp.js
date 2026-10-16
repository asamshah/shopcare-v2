// ShopCare on the storefront.
//   [data-care-offer]      product page: Care plans as Apple-style cards
//   [data-care-later]      add Care to something the customer already owns
//   [data-repair-status-list]  the customer's repairs, with a quote to review & pay
//                              and, while we wait for the item, its postage slip
//
// Product-page offers register with one Add to cart coordinator per product
// form. With no offer chosen, the theme's own Add to cart runs untouched. When
// one is chosen, Add to cart sends the product plus what the offers add in one
// /cart/add.js call, then shows the theme's cart the way the theme would (see
// showCart): Dawn-family drawers re-render from the sections returned, Horizon
// hears its cart:update event and its drawer opens, other section-rendered
// drawers are re-fetched with the Section Rendering API, and only a theme
// with no drawer we can recognise goes to the cart page. If the offers add nothing, the submit is handed back to
// the theme. When the cart already has a plan for this product, ShopCare adds
// the product itself and then sets the plan line's quantity to the product
// line's, so every unit stays covered.
(function () {
  if (window.ShopCareStorefront) return; // blocks may include this script more than once
  window.ShopCareStorefront = true;

  function money(amount, currency) {
    try {
      // Whole amounts without pennies (£40, not £40.00), like Apple's pricing.
      var value = Number(amount);
      var whole = value % 1 === 0;
      return new Intl.NumberFormat(document.documentElement.lang || undefined, {
        style: "currency", currency: currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2
      }).format(value);
    } catch (e) {
      return amount + " " + currency;
    }
  }

  function showError(root, message) {
    var el = root.querySelector("[data-shopcare-error]");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  }

  function getJSON(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (r) { return r.json(); });
  }

  // ---------- The theme's cart ----------
  // Dawn-family themes: <cart-notification> or <cart-drawer>, which re-render
  // from bundled section HTML (the same lookup as Dawn's product-form.js).
  function themeCart() {
    var cart = document.querySelector("cart-notification") || document.querySelector("cart-drawer");
    return cart && typeof cart.renderContents === "function" && typeof cart.getSectionsToRender === "function" ? cart : null;
  }

  // Any other cart drawer we can recognise: it hears the cart events, and if
  // it sits in a theme section, that section is re-rendered.
  var DRAWER = "cart-drawer, cart-notification, cart-drawer-component, [data-cart-drawer], [id*='cart-drawer'], " +
    "#CartDrawer, .cart-drawer";

  // Shopify's Horizon: <cart-drawer-component> (a dialog with open()), whose
  // cart lines and header icon re-render on the cart:update event.
  function horizonDrawer() {
    return document.querySelector("cart-drawer-component");
  }

  // Section Rendering API: re-fetch the theme sections the drawers sit in
  // (<div id="shopify-section-ID">) and swap their contents. Returns false if
  // no drawer is inside a section.
  function refreshSections(drawers) {
    var wrappers = [];
    drawers.forEach(function (drawer) {
      var wrapper = drawer.closest('[id^="shopify-section-"]');
      if (wrapper && wrappers.indexOf(wrapper) === -1) wrappers.push(wrapper);
    });
    if (!wrappers.length) return false;
    var ids = wrappers.map(function (wrapper) { return wrapper.id.replace("shopify-section-", ""); });
    getJSON(window.location.pathname + "?sections=" + ids.map(encodeURIComponent).join(","))
      .then(function (sections) {
        wrappers.forEach(function (wrapper, index) {
          var html = sections && sections[ids[index]];
          if (!html) return;
          var fresh = new DOMParser().parseFromString(html, "text/html").getElementById(wrapper.id);
          wrapper.innerHTML = fresh ? fresh.innerHTML : html;
        });
      }, function () {});
    return true;
  }

  // POST to the Ajax Cart API; asks for the theme's cart sections unless
  // `withSections` is false (a request that isn't the last one).
  function postCart(url, body, withSections) {
    var cart = themeCart();
    if (cart && withSections !== false) {
      body.sections = cart.getSectionsToRender().map(function (section) { return section.id; });
      body.sections_url = window.location.pathname;
    }
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (response) {
        if (!r.ok) throw new Error(response.description || response.message || "Couldn't add to cart");
        return response;
      });
    });
  }

  function addToCart(url, items, withSections) {
    return postCart(url, { items: items }, withSections);
  }

  // The product line a plan line hangs off: by its parent_relationship, else
  // the first line of the product's variant without a plan tag of its own.
  function parentLine(cart, planLine, parentId) {
    var items = (cart && cart.items) || [];
    var key = planLine.parent_relationship && planLine.parent_relationship.parent_key;
    return items.find(function (line) { return key && line.key === key; }) ||
      items.find(function (line) { return String(line.variant_id) === String(parentId) && !(line.properties && line.properties._shopcare_for); });
  }

  // Another unit of a product whose plan is already in the cart. Shopify
  // removes a nested line with its parent, but doesn't change the nested
  // line's quantity when the parent's changes (nested cart lines docs), so:
  // add the product, read the cart back, and set the plan line's quantity to
  // the product line's with /cart/change.js (sent even when they already
  // match, so its response carries the theme's fresh cart sections). The
  // sections and the added line go to showCart as one add response would.
  function addAndSyncPlans(coordinator, context) {
    return addToCart(coordinator.cartAddUrl, [context.product], false).then(function (added) {
      return getJSON(coordinator.cartUrl + ".js").then(function (cart) {
        return context.sync.reduce(function (chain, plan) {
          return chain.then(function (last) {
            var fresh = ((cart && cart.items) || []).find(function (line) { return line.key === plan.line.key; });
            var parent = fresh && parentLine(cart, fresh, plan.parentId);
            if (!parent) return last;
            return postCart(coordinator.cartChangeUrl, { id: fresh.key, quantity: parent.quantity });
          });
        }, Promise.resolve(null));
      }).then(function (changed) {
        return { items: added.items, sections: changed ? changed.sections : undefined };
      });
    });
  }

  // After /cart/add.js: tell the theme, then show its cart (or go to the cart page).
  function showCart(response, cartUrl) {
    var items = (response && response.items) || [];
    var detail = { source: "shopcare", items: items };
    ["cart:refresh", "theme:cart:change"].forEach(function (name) {
      document.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: detail }));
    });
    if (typeof window.publish === "function" && window.PUB_SUB_EVENTS) {
      window.publish(window.PUB_SUB_EVENTS.cartUpdate, { source: "product-form", productVariantId: items[0] && items[0].variant_id, cartData: response });
    }

    var cart = themeCart();
    if (cart && response.sections) {
      cart.classList.remove("is-empty");
      // Dawn reads the added line (key / id) and its sections from one object.
      cart.renderContents(Object.assign({}, items[0], { sections: response.sections }));
      return;
    }

    var horizon = horizonDrawer();
    if (horizon) {
      // Horizon's listeners want the cart's item count (the header bubble) and
      // re-render their own sections when none are passed.
      getJSON(cartUrl + ".js").then(function (current) {
        document.dispatchEvent(new CustomEvent("cart:update", { bubbles: true, detail: {
          resource: current, sourceId: "shopcare",
          data: { source: "shopcare", itemCount: current.item_count, sections: response.sections || {} }
        } }));
        if (typeof horizon.open === "function") horizon.open();
        else if (typeof horizon.showDialog === "function") horizon.showDialog();
      }, function () {});
      return;
    }

    var drawers = Array.prototype.slice.call(document.querySelectorAll(DRAWER));
    if (drawers.length) {
      refreshSections(drawers);
      return;
    }
    window.location.href = cartUrl;
  }

  // ---------- Add to cart coordinator ----------
  var coordinators = [];

  // The product form: posts to /cart/add, carries the variant id, and has a
  // submit button. Dawn renders a payment-terms form first that has an id but
  // no button. form.elements also counts inputs tied on with form="…".
  function isProductForm(form) {
    return !!form.elements.namedItem("id") &&
      Array.prototype.some.call(form.elements, function (field) { return field.type === "submit"; });
  }

  function productForm(root) {
    var scopes = [root.closest(".shopify-section, section"), document];
    for (var i = 0; i < scopes.length; i++) {
      if (!scopes[i]) continue;
      var match = Array.prototype.find.call(scopes[i].querySelectorAll('form[action*="/cart/add"]'), isProductForm);
      if (match) return match;
    }
    return null;
  }

  function submitButton(form) {
    return Array.prototype.find.call(form.elements, function (field) { return field.type === "submit"; });
  }

  function register(root, offer) {
    var form = productForm(root);
    if (!form) return false;
    var coordinator = coordinators.find(function (c) { return c.form === form; });
    if (!coordinator) {
      var cartUrl = root.getAttribute("data-cart-url");
      coordinator = { form: form, offers: [], handingBack: false, cartAddUrl: root.getAttribute("data-cart-add-url"),
                      cartUrl: cartUrl, cartChangeUrl: root.getAttribute("data-cart-change-url") || cartUrl + "/change.js" };
      coordinators.push(coordinator);
      // Capture phase, so this runs before the theme's own handler.
      form.addEventListener("submit", function (event) { submit(coordinator, event); }, true);
    }
    offer.root = root;
    coordinator.offers.push(offer);
    return true;
  }

  // Re-submit the form without us, so the theme's own Add to cart runs.
  function handBack(coordinator) {
    coordinator.handingBack = true;
    try {
      if (coordinator.form.requestSubmit) coordinator.form.requestSubmit();
      else submitButton(coordinator.form).click();
    } finally {
      coordinator.handingBack = false;
    }
  }

  function submit(coordinator, event) {
    if (coordinator.handingBack) return;
    var data = new FormData(coordinator.form);
    var active = coordinator.offers.filter(function (offer) { return offer.isActive(data); });
    if (!active.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    var product = { id: Number(data.get("id")), quantity: Number(data.get("quantity") || 1), properties: {} };
    data.forEach(function (value, key) {
      var match = key.match(/^properties\[(.+)\]$/);
      if (match) product.properties[match[1]] = value;
    });
    if (data.get("selling_plan")) product.selling_plan = Number(data.get("selling_plan"));
    var context = { product: product, extra: [], sync: [], cart: null };

    var button = submitButton(coordinator.form);
    if (button) button.disabled = true;
    active.forEach(function (offer) { showError(offer.root, ""); });

    // The current cart, so offers don't add what's already there (best effort).
    getJSON(coordinator.cartUrl + ".js")
      .then(function (cart) { context.cart = cart; }, function () {})
      // Offers prepare one after another (an offer may need a request first).
      .then(function () {
        return active.reduce(function (chain, offer) {
          return chain.then(function () {
            return Promise.resolve(offer.prepare(context)).catch(function (error) {
              showError(offer.root, error.message);
              throw error;
            });
          });
        }, Promise.resolve());
      })
      .then(function () {
        if (!context.extra.length && !context.sync.length) {
          if (button) button.disabled = false;
          return handBack(coordinator);
        }
        var adding = context.extra.length
          ? addToCart(coordinator.cartAddUrl, [context.product].concat(context.extra))
          : addAndSyncPlans(coordinator, context);
        return adding
          .then(function (response) {
            if (button) button.disabled = false;
            showCart(response, coordinator.cartUrl);
          });
      })
      .catch(function (error) {
        if (button) button.disabled = false;
        if (!active.some(function (offer) { return !offer.root.querySelector("[data-shopcare-error]").hidden; })) {
          showError(active[0].root, error.message);
        }
      });
  }

  // ---------- Selectable cards (Apple-style radio cards) ----------
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function makeCard(className) {
    var card = el("div", "shopcare-pdp__card" + (className ? " " + className : ""));
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", "false");
    card.tabIndex = 0;
    return card;
  }

  // Clicking (or Enter/Space on) a card checks it and unchecks its siblings.
  function onSelect(card, group, callback) {
    function select() {
      group().forEach(function (other) { other.setAttribute("aria-checked", other === card ? "true" : "false"); });
      callback();
    }
    card.addEventListener("click", function (event) {
      if (event.target.closest("a, button, input, label, summary")) return;
      select();
    });
    card.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
    });
  }

  // ---------- Care offer ----------
  function initCareOffer(root) {
    var list = root.querySelector("[data-care-options]");
    var chosen = null;
    // Variant ids with a plan in the cart (read when the plans load, kept up
    // to date by our own adds). Lets Add to cart step in for another unit of
    // a covered product even when no card is chosen; prepare() re-checks the
    // live cart, so a stale entry only costs one /cart.js read.
    var covered = {};

    function planLineFor(cart, parentId) {
      return ((cart && cart.items) || []).find(function (line) {
        return line.properties && line.properties._shopcare_for === String(parentId);
      });
    }
    var cards = function () { return Array.prototype.slice.call(list.querySelectorAll('[role="radio"]')); };

    // The block renders with placeholders; swap them for the cards, or hide the
    // block when there's nothing to offer.
    function settle(show) {
      root.removeAttribute("aria-busy");
      root.hidden = !show;
    }

    var registered = register(root, {
      isActive: function (data) { return !!chosen || !!covered[String(data.get("id"))]; },
      prepare: function (context) {
        var parentId = context.product.id;
        // One plan line per product: if the cart already has one for this
        // variant, its quantity follows the product's instead.
        var existing = planLineFor(context.cart, parentId);
        if (existing) {
          context.sync.push({ line: existing, parentId: parentId });
          return;
        }
        delete covered[String(parentId)];
        if (!chosen) return;
        covered[String(parentId)] = true;
        context.extra.push({ id: Number(chosen.variant_id), quantity: context.product.quantity, parent_id: parentId,
                             properties: { _shopcare_for: String(parentId) } });
      }
    });
    if (!registered) { settle(false); return; }

    function planCard(plan, currency) {
      var card = makeCard("shopcare-pdp__card--plan");
      var title = el("span", "shopcare-pdp__card-title");
      title.innerHTML = '<svg class="shopcare-pdp__icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.5 3 4.2v5.1c0 4.3 2.9 7.6 7 9.2 4.1-1.6 7-4.9 7-9.2V4.2L10 1.5Zm-1.1 11.6L5.6 9.8l1.2-1.2 2.1 2.1 4.3-4.3 1.2 1.2-5.5 5.5Z"/></svg>';
      title.appendChild(document.createTextNode(plan.name));
      card.appendChild(title);
      var subtitle = (root.getAttribute("data-subtitle") || "")
        .replace("{months}", plan.term_months).replace("{product}", root.getAttribute("data-product-title") || "");
      if (subtitle) card.appendChild(el("span", "shopcare-pdp__card-text", subtitle));
      card.appendChild(el("span", "shopcare-pdp__price",
        money(plan.price, currency) + (root.getAttribute("data-price-suffix") ? " " + root.getAttribute("data-price-suffix") : "")));
      card.appendChild(el("hr", "shopcare-pdp__rule"));
      var benefits = el("ul", "shopcare-pdp__benefits");
      plan.benefits.forEach(function (text) { benefits.appendChild(el("li", null, text)); });
      card.appendChild(benefits);
      // "What's covered": the plan's generated terms, ending with the statutory rights line.
      if (plan.terms && plan.terms.length) {
        var details = el("details", "shopcare-pdp__how");
        var summary = el("summary");
        summary.appendChild(el("span", "shopcare-pdp__card-title", root.getAttribute("data-terms-label") || "What's covered"));
        summary.appendChild(el("span", "shopcare-pdp__plus", "+")).setAttribute("aria-hidden", "true");
        details.appendChild(summary);
        plan.terms.forEach(function (line) { details.appendChild(el("p", null, line)); });
        card.appendChild(details);
      }
      onSelect(card, cards, function () { chosen = plan; });
      return card;
    }

    getJSON(root.getAttribute("data-plans-url"))
      .then(function (data) {
        if (!data || !data.ok || !data.plans || !data.plans.length) { settle(false); return; }
        getJSON(root.getAttribute("data-cart-url") + ".js").then(function (cart) {
          ((cart && cart.items) || []).forEach(function (line) {
            if (line.properties && line.properties._shopcare_for) covered[line.properties._shopcare_for] = true;
          });
        }, function () {});
        list.textContent = "";
        data.plans.forEach(function (plan) { list.appendChild(planCard(plan, data.currency || "GBP")); });
        var none = makeCard();
        none.appendChild(el("span", "shopcare-pdp__card-title", root.getAttribute("data-decline-label") || "No coverage"));
        onSelect(none, cards, function () { chosen = null; });
        list.appendChild(none);
        settle(true);
      })
      .catch(function () { settle(false); }); // no offer if the app can't be reached
  }

  // ---------- Add Care later ----------
  function initCareLater(root) {
    var list = root.querySelector("[data-care-list]");
    if (!list) return;

    function add(item, plan, button) {
      button.disabled = true;
      showError(root, "");
      addToCart(root.getAttribute("data-cart-add-url"), [
        { id: Number(plan.variant_id), quantity: 1, properties: { _shopcare_item: String(item.item_id), Product: item.product_title } }
      ])
        .then(function (response) { button.textContent = "Added"; showCart(response, root.getAttribute("data-cart-url")); })
        .catch(function (error) { showError(root, error.message); button.disabled = false; });
    }

    getJSON(root.getAttribute("data-offers-url"))
      .then(function (data) {
        root.querySelector("[data-care-loading]").hidden = true;
        var items = (data && data.items) || [];
        if (!items.length) { root.querySelector("[data-care-empty]").hidden = false; return; }
        items.forEach(function (item) {
          var card = document.createElement("div");
          card.className = "shopcare__item";
          var title = document.createElement("strong");
          title.textContent = item.product_title;
          card.appendChild(title);
          item.plans.forEach(function (plan) {
            var row = document.createElement("div");
            row.className = "shopcare__item-plan";
            var text = document.createElement("span");
            text.textContent = (plan.badge || plan.name) + " · " + money(plan.price, data.currency) +
              " · add by " + new Date(plan.offer_ends).toLocaleDateString();
            var button = document.createElement("button");
            button.type = "button";
            button.className = "button shopcare__button";
            button.textContent = "Add Care";
            button.addEventListener("click", function () { add(item, plan, button); });
            row.appendChild(text);
            row.appendChild(button);
            card.appendChild(row);
          });
          list.appendChild(card);
        });
      })
      .catch(function () {
        root.querySelector("[data-care-loading]").hidden = true;
        showError(root, "Couldn't load your purchases. Please try again.");
      });
  }

  // ---------- Repair status ----------
  function initRepairStatus(root) {
    var list = root.querySelector("[data-status-list]");
    if (!list) return;

    function link(text, href) {
      var a = el("a", "button shopcare__button", text);
      a.href = href;
      return a;
    }

    getJSON(root.getAttribute("data-status-url"))
      .then(function (data) {
        root.querySelector("[data-status-loading]").hidden = true;
        var tickets = (data && data.tickets) || [];
        if (!tickets.length) { root.querySelector("[data-status-empty]").hidden = false; return; }
        tickets.forEach(function (ticket) {
          var card = el("div", "shopcare__item");
          card.appendChild(el("strong", null, ticket.product_title || "Repair #" + ticket.id));
          // "ShopCare – 2 year plan" / "Covered until …", or "12-month warranty" / "Until …".
          if (ticket.cover) {
            var cover = el("span", "shopcare__badge shopcare__badge--" + ticket.cover.kind, ticket.cover.badge || ticket.cover.name);
            card.appendChild(cover);
            card.appendChild(el("span", "shopcare__badge-detail",
              (ticket.cover.kind === "care" ? "Covered until " : "Until ") + new Date(ticket.cover.ends_at).toLocaleDateString()));
          }
          var row = el("div", "shopcare__item-plan");
          row.appendChild(el("span", null, "Repair #" + ticket.id + " · " + ticket.status_label));
          var quote = ticket.quotation;
          if (quote && quote.review_url) {
            row.appendChild(link("Quote ready – review & pay", quote.review_url));
          }
          // Waiting for the item: the printable label + packing slip (a PDF).
          if (ticket.postage_slip_url) {
            var slip = link("Download postage slip", ticket.postage_slip_url);
            slip.target = "_blank";
            slip.rel = "noopener";
            row.appendChild(slip);
          }
          card.appendChild(row);
          list.appendChild(card);
        });
      })
      .catch(function () {
        root.querySelector("[data-status-loading]").hidden = true;
        showError(root, "Couldn't load your repairs. Please try again.");
      });
  }

  function init() {
    document.querySelectorAll("[data-care-offer]").forEach(initCareOffer);
    document.querySelectorAll("[data-care-later]").forEach(initCareLater);
    document.querySelectorAll("[data-repair-status-list]").forEach(initRepairStatus);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

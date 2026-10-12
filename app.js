(() => {
  "use strict";

  const WHATSAPP_NUMBER = "";
  const authScreen = document.getElementById("auth-screen");
  const appShell = document.getElementById("app-shell");
  const authForm = document.getElementById("auth-form");
  const authFields = document.getElementById("auth-fields");
  const authError = document.getElementById("auth-error");
  const authSubmit = document.getElementById("auth-submit");
  const dialog = document.getElementById("app-modal");
  const passwordDialog = document.getElementById("password-dialog");
  const passwordForm = document.getElementById("password-form");
  const form = document.getElementById("app-form");
  const fieldsContainer = document.getElementById("modal-fields");
  const formError = document.getElementById("form-error");
  const toast = document.getElementById("toast");
  let activeDialogType = "";
  let selectedService = "";
  let currentUser = null;
  let authMode = "login";
  let toastTimer;

  const icons = {
    transfer: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 7h13m0 0-4-4m4 4-4 4M17 17H4m0 0 4-4m-4 4 4 4"/></svg>',
    request: '<svg viewBox="0 0 24 24" fill="none"><path d="M8 3h8l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3Zm7 1v5h5M8 13h8m-8 4h5"/></svg>',
  };

  const escapeHTML = (value) =>
    String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        credentials: "same-origin",
        ...options,
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
      });
    } catch {
      throw new Error("Impossible de joindre le serveur. Vérifiez que Money Express Mobile est démarré.");
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("Le serveur a renvoyé une réponse invalide. Réessayez plus tard.");
    }
    if (!response.ok) {
      if (response.status === 401 && currentUser) {
        showAuth("Votre session a expiré. Veuillez vous reconnecter.");
      }
      throw new Error(result.error || "La demande n’a pas abouti. Réessayez.");
    }
    return result;
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("toast-visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("toast-visible"), 4600);
  }

  async function renderRequests() {
    const sessionUser = currentUser;
    if (!sessionUser) return;
    const requestList = document.getElementById("requests-list");
    let items;
    try {
      const result = await api("/api/requests");
      if (currentUser !== sessionUser) return;
      items = result.requests;
    } catch (error) {
      if (currentUser === sessionUser) {
        requestList.innerHTML = `<div class="request-empty">${escapeHTML(error.message)}</div>`;
      }
      return;
    }
    const count = items.length;

    document.getElementById("request-count").textContent = String(count);
    document.getElementById("open-requests").textContent = String(count);

    if (count === 0) {
      requestList.innerHTML =
        sessionUser.role === "admin"
          ? '<div class="admin-empty">Aucune demande client n’a encore été reçue.</div>'
          : '<div class="request-empty"><span>Aucune demande pour le moment.</span>Vos demandes et transferts apparaîtront ici.</div>';
      return;
    }

    requestList.innerHTML = items.slice(0, sessionUser.role === "admin" ? 200 : 4).map((item) => {
      const isTransfer = item.kind === "transfer";
      const label = isTransfer ? "Transfert" : "Demande";
      const date = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" })
        .format(new Date(item.createdAt));
      const detail = isTransfer
        ? `${escapeHTML(item.service)} · ${escapeHTML(item.amount)} ${escapeHTML(item.currency)}`
        : `${escapeHTML(item.service)} · ${escapeHTML(date)}`;
      const statuses = {
        pending: ["En attente", ""],
        prepared: ["Préparé", "status-prepared"],
        processing: ["En traitement", "status-processing"],
        completed: ["Terminé", "status-completed"],
        rejected: ["Refusé", "status-rejected"],
      };
      const [statusLabel, statusClass] = statuses[item.status] || statuses.pending;
      const adminDetails = sessionUser.role === "admin"
        ? `<span class="request-owner">${escapeHTML(item.name || item.email)}${item.name ? ` · ${escapeHTML(item.email)}` : ""}</span>`
        : "";
      const adminStatusControl = sessionUser.role === "admin"
        ? `<select class="status-select" data-status-id="${escapeHTML(item.id)}" aria-label="Modifier le statut de ${escapeHTML(item.id)}">
            ${Object.entries(statuses).map(([value, [text]]) => `<option value="${value}" ${value === item.status ? "selected" : ""}>${text}</option>`).join("")}
          </select>`
        : "";

      return `<div class="request-row">
        <span class="request-type-icon" aria-hidden="true">${isTransfer ? icons.transfer : icons.request}</span>
        <span class="request-info"><strong>${label} · ${escapeHTML(item.id)}</strong><span>${detail}</span>${adminDetails}</span>
        ${adminStatusControl || `<span class="status-badge ${statusClass}">${statusLabel}</span>`}
      </div>`;
    }).join("");

    if (sessionUser.role === "admin") {
      requestList.querySelectorAll("[data-status-id]").forEach((select) => {
        select.addEventListener("change", async () => {
          select.disabled = true;
          try {
            await api(`/api/requests/${encodeURIComponent(select.dataset.statusId)}/status`, {
              method: "PATCH",
              body: JSON.stringify({ status: select.value }),
            });
            await renderRequests();
            showToast("Le statut de la demande a été mis à jour.");
          } catch (error) {
            showToast(error.message);
            select.disabled = false;
          }
        });
      });
    }
  }

  function setAuthMode(mode) {
    authMode = mode;
    const registration = mode === "register";
    document.getElementById("auth-title").textContent = registration ? "Votre espace commence ici." : "Ravi de vous retrouver.";
    document.getElementById("auth-description").textContent = registration
      ? "Créez votre compte client pour préparer et suivre vos demandes."
      : "Connectez-vous pour accéder à vos demandes et à vos services.";
    document.getElementById("auth-switch-copy").textContent = registration
      ? "Vous avez déjà un compte ?"
      : "Vous n’avez pas encore de compte ?";
    document.getElementById("auth-switch").textContent = registration ? "Se connecter" : "Créer un compte client";
    document.getElementById("auth-admin-note").hidden = registration;
    authSubmit.innerHTML = registration
      ? "Créer mon compte <span aria-hidden=\"true\">→</span>"
      : "Se connecter <span aria-hidden=\"true\">→</span>";
    authError.textContent = "";
    authFields.innerHTML = [
      ...(registration
        ? ['<div class="auth-field"><label for="auth-name">Nom complet</label><input id="auth-name" name="name" type="text" required minlength="2" maxlength="100" autocomplete="name" placeholder="Votre nom et prénom" /></div>']
        : []),
      '<div class="auth-field"><label for="auth-email">Adresse e-mail</label><input id="auth-email" name="email" type="email" required maxlength="254" autocomplete="email" placeholder="vous@exemple.com" /></div>',
      `<div class="auth-field"><label for="auth-password">Mot de passe</label><input id="auth-password" name="password" type="password" required minlength="12" maxlength="128" autocomplete="${registration ? "new-password" : "current-password"}" placeholder="${registration ? "12 caractères minimum" : "Votre mot de passe"}" />${registration ? '<span class="auth-field-hint">Utilisez au moins 12 caractères ; préférez une phrase de passe unique.</span>' : ""}</div>`,
    ].join("");
  }

  function showAuth(message = "") {
    currentUser = null;
    appShell.hidden = true;
    authScreen.hidden = false;
    if (dialog.open) dialog.close();
    if (passwordDialog.open) passwordDialog.close();
    document.getElementById("requests-list").replaceChildren();
    document.getElementById("request-count").textContent = "0";
    document.getElementById("open-requests").textContent = "0";
    document.getElementById("profile-name").textContent = "";
    document.getElementById("profile-role").textContent = "";
    document.getElementById("profile-avatar").textContent = "M";
    authSubmit.disabled = false;
    setAuthMode("login");
    authError.textContent = message;
    document.getElementById("auth-email").focus();
  }

  function showApp(user) {
    currentUser = user;
    authScreen.hidden = true;
    appShell.hidden = false;
    const isAdmin = user.role === "admin";
    document.getElementById("profile-name").textContent = user.name;
    document.getElementById("profile-role").textContent = isAdmin ? "Administrateur" : "Client Money Express";
    document.getElementById("profile-avatar").textContent = user.name.trim().charAt(0).toLocaleUpperCase("fr-FR");
    document.getElementById("welcome-heading").innerHTML = `Bonjour ${isAdmin ? "l’équipe " : ""}<span class="wave">👋</span>`;
    document.getElementById("requests-eyebrow").textContent = isAdmin ? "ESPACE ADMINISTRATEUR" : "VOTRE ESPACE CLIENT";
    document.getElementById("requests-heading").textContent = isAdmin ? "Suivi des demandes" : "Mes demandes";
    document.getElementById("requests-description").textContent = isAdmin
      ? "Consultez les demandes clients et mettez à jour leur statut."
      : "Suivez ici le traitement de vos demandes par Money Express.";
    document.getElementById("new-request-button").hidden = isAdmin;
    document.getElementById("fidelite").hidden = isAdmin;
    document.querySelector(".stats-grid .stat-card:first-child").hidden = isAdmin;
    document.querySelectorAll("[data-client-only]").forEach((link) => { link.hidden = isAdmin; });
    document.querySelectorAll("[data-open-modal]").forEach((button) => { button.hidden = isAdmin; });
    document.querySelectorAll("[data-service]").forEach((button) => {
      button.disabled = isAdmin;
      button.setAttribute("aria-disabled", String(isAdmin));
    });
    renderRequests();
  }

  async function submitAuth(event) {
    event.preventDefault();
    authError.textContent = "";
    if (!authForm.reportValidity()) return;
    const values = Object.fromEntries(new FormData(authForm).entries());
    authSubmit.disabled = true;
    try {
      const { user } = await api(`/api/auth/${authMode === "register" ? "register" : "login"}`, {
        method: "POST",
        body: JSON.stringify(values),
      });
      showApp(user);
    } catch (error) {
      authError.textContent = error.message;
      authSubmit.disabled = false;
    }
  }

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      showAuth("Vous êtes déconnecté.");
    } catch (error) {
      showToast(error.message);
    }
  }

  async function submitPassword(event) {
    event.preventDefault();
    const errorElement = document.getElementById("password-error");
    const submit = document.getElementById("password-submit");
    errorElement.textContent = "";
    if (!passwordForm.reportValidity()) return;
    const values = Object.fromEntries(new FormData(passwordForm).entries());
    if (values.newPassword !== values.confirmPassword) {
      errorElement.textContent = "Les deux nouveaux mots de passe ne correspondent pas.";
      document.getElementById("confirm-password").focus();
      return;
    }
    delete values.confirmPassword;
    submit.disabled = true;
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: JSON.stringify(values),
      });
      passwordDialog.close();
      passwordForm.reset();
      showToast("Votre mot de passe a été modifié. Vos autres sessions ont été déconnectées.");
    } catch (error) {
      errorElement.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }

  function field({ name, label, type = "text", placeholder = "", options = [], required = true, hint = "", full = false, min = "", maxLength = "" }) {
    const attr = `${required ? "required" : ""}${min ? ` min="${escapeHTML(min)}"` : ""}${maxLength ? ` maxlength="${escapeHTML(maxLength)}"` : ""}`;
    let control;
    if (type === "select") {
      control = `<select name="${escapeHTML(name)}" id="field-${escapeHTML(name)}" ${attr}>
        <option value="" disabled selected>Choisir une option</option>
        ${options.map((option) => `<option value="${escapeHTML(option)}" ${option === selectedService ? "selected" : ""}>${escapeHTML(option)}</option>`).join("")}
      </select>`;
    } else if (type === "textarea") {
      control = `<textarea name="${escapeHTML(name)}" id="field-${escapeHTML(name)}" placeholder="${escapeHTML(placeholder)}" ${attr}></textarea>`;
    } else {
      control = `<input type="${escapeHTML(type)}" name="${escapeHTML(name)}" id="field-${escapeHTML(name)}" placeholder="${escapeHTML(placeholder)}" ${attr} autocomplete="${type === "tel" ? "tel" : "off"}" />`;
    }
    return `<div class="field-group${full ? " field-full" : ""}">
      <label for="field-${escapeHTML(name)}">${escapeHTML(label)}</label>${control}
      ${hint ? `<span class="field-hint">${escapeHTML(hint)}</span>` : ""}
    </div>`;
  }

  function openModal(type, service = "") {
    activeDialogType = type;
    selectedService = service === "Canal+" ? "Canal+ & CanalBox" : service;
    form.reset();
    formError.textContent = "";
    const title = document.getElementById("modal-title");
    const description = document.getElementById("modal-description");
    const icon = document.getElementById("modal-icon");
    const submit = document.getElementById("modal-submit");

    if (type === "transfer") {
      title.textContent = "Préparer un transfert";
      description.textContent = "Renseignez les informations utiles à votre opération. Cette préparation ne réserve ni n’exécute un transfert.";
      icon.innerHTML = icons.transfer;
      submit.innerHTML = "Enregistrer ma préparation <span aria-hidden=\"true\">→</span>";
      fieldsContainer.innerHTML = [
        field({ name: "service", label: "Service de transfert", type: "select", options: ["Western Union", "Express Union", "Mobile Money", "Airtel Money"] }),
        field({ name: "amount", label: "Montant indicatif", type: "number", placeholder: "Ex. 50 000", min: "1" }),
        field({ name: "currency", label: "Devise", type: "select", options: ["FCFA", "EUR", "USD"] }),
        field({ name: "recipient", label: "Nom du bénéficiaire", placeholder: "Nom et prénom" }),
        field({ name: "phone", label: "Téléphone du bénéficiaire", type: "tel", placeholder: "+237 …", full: true, hint: "Ne renseignez jamais un code secret, un mot de passe ou un code de validation." }),
      ].join("");
    } else {
      title.textContent = "Faire une demande";
      description.textContent = "Décrivez votre besoin pour le transmettre de manière sécurisée à Money Express.";
      icon.innerHTML = icons.request;
      submit.innerHTML = "Enregistrer ma demande <span aria-hidden=\"true\">→</span>";
      const services = ["Billet d’avion", "Assurance automobile", "Offres NSIA", "Mobile Money", "Airtel Money", "Western Union", "Express Union", "Canal+ & CanalBox", "Autre demande"];
      fieldsContainer.innerHTML = [
        field({ name: "service", label: "Votre besoin", type: "select", options: services }),
        field({ name: "name", label: "Votre nom", placeholder: "Nom et prénom", maxLength: "100" }),
        field({ name: "phone", label: "Téléphone", type: "tel", placeholder: "+237 …", full: true }),
        field({ name: "details", label: "Quelques précisions", type: "textarea", placeholder: "Votre destination, vos questions, les détails utiles…", required: false, full: true }),
      ].join("");
    }

    dialog.showModal();
    dialog.querySelector("input, select, textarea").focus();
  }

  function closeModal() {
    dialog.close();
    formError.textContent = "";
  }

  async function onSubmit(event) {
    event.preventDefault();
    formError.textContent = "";
    if (!form.reportValidity()) return;

    const isTransfer = activeDialogType === "transfer";
    const data = Object.fromEntries(new FormData(form).entries());
    data.kind = isTransfer ? "transfer" : "request";
    const submit = document.getElementById("modal-submit");
    submit.disabled = true;
    try {
      const { request } = await api("/api/requests", {
        method: "POST",
        body: JSON.stringify(data),
      });
      closeModal();
      await renderRequests();
      showToast(isTransfer
        ? `Préparation ${request.id} transmise à Money Express. Elle ne réserve ni n’exécute un transfert.`
        : `Demande ${request.id} transmise à Money Express.`);
      document.getElementById("demandes").scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (error) {
      formError.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }

  function openSupport() {
    const message = "Bonjour Money Express, j’aimerais obtenir des informations sur vos services.";
    const recipient = WHATSAPP_NUMBER ? `${WHATSAPP_NUMBER}?` : "?";
    const destination = `https://wa.me/${recipient}text=${encodeURIComponent(message)}`;
    const chatWindow = window.open(destination, "_blank");

    if (!chatWindow) {
      showToast("WhatsApp n’a pas pu s’ouvrir. Autorisez les fenêtres contextuelles, puis réessayez.");
      return;
    }
    chatWindow.opener = null;
    if (!WHATSAPP_NUMBER) {
      showToast("Dans WhatsApp, choisissez et vérifiez le compte officiel Money Express avant d’envoyer votre message.");
    }
  }

  document.querySelectorAll("[data-open-modal]").forEach((button) => {
    button.addEventListener("click", () => openModal(button.dataset.openModal));
  });
  document.querySelectorAll("[data-service]").forEach((button) => {
    button.addEventListener("click", () => openModal("request", button.dataset.service));
  });
  document.querySelectorAll(".support-action").forEach((button) => {
    button.addEventListener("click", openSupport);
  });

  authForm.addEventListener("submit", submitAuth);
  document.getElementById("auth-switch").addEventListener("click", () => {
    setAuthMode(authMode === "login" ? "register" : "login");
    document.getElementById("auth-email").focus();
  });
  document.getElementById("logout-button").addEventListener("click", logout);
  document.getElementById("change-password-button").addEventListener("click", () => {
    passwordForm.reset();
    document.getElementById("password-error").textContent = "";
    passwordDialog.showModal();
    document.getElementById("current-password").focus();
  });
  document.getElementById("password-close").addEventListener("click", () => passwordDialog.close());
  document.getElementById("password-cancel").addEventListener("click", () => passwordDialog.close());
  passwordForm.addEventListener("submit", submitPassword);
  passwordDialog.addEventListener("close", () => {
    if (authScreen.hidden) document.getElementById("change-password-button").focus();
  });
  passwordDialog.addEventListener("click", (event) => {
    if (event.target === passwordDialog) passwordDialog.close();
  });
  document.getElementById("new-request-button").addEventListener("click", () => openModal("request"));
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  form.addEventListener("submit", onSubmit);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeModal();
  });
  dialog.addEventListener("close", () => {
    if (authScreen.hidden) document.getElementById("new-request-button").focus();
  });

  document.querySelectorAll(".loyalty-link, .stat-card>a[href='#fidelite']").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      showToast("Les offres fidélité sont définies par votre agence. Contactez-la pour connaître les avantages disponibles.");
    });
  });
  document.querySelector("[data-scroll-services]").addEventListener("click", () => {
    document.querySelector(".services-grid").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  document.getElementById("today-label").querySelector("span").textContent =
    new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
  document.getElementById("footer-year").textContent = String(new Date().getFullYear());

  const navLinks = [...document.querySelectorAll("[data-nav]")];
  const observeableSections = ["accueil", "services", "transfert", "demandes", "fidelite"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if ("IntersectionObserver" in window) {
    const navObserver = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting)
        .sort((first, second) => second.intersectionRatio - first.intersectionRatio)[0];
      if (!visible) return;
      navLinks.forEach((link) => {
        const isActive = link.dataset.nav === visible.target.id;
        link.classList.toggle("active", isActive);
        if (isActive) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    }, { rootMargin: "-15% 0px -70% 0px", threshold: [0, 0.15, 0.4] });
    observeableSections.forEach((section) => navObserver.observe(section));
  }

  setAuthMode("login");
  api("/api/auth/session")
    .then(({ user }) => {
      if (user) showApp(user);
    })
    .catch((error) => {
      authError.textContent = error.message.startsWith("Impossible de joindre le serveur.")
        ? `${error.message} Démarrez le serveur avec « node --env-file=.env server.js » en local, ou contactez l’équipe technique pour le site hébergé.`
        : error.message;
    });
})();

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
  const detailDialog = document.getElementById("detail-modal");
  const detailContent = document.getElementById("detail-modal-content");
  const detailClose = document.getElementById("detail-modal-close");
  const detailOk = document.getElementById("detail-modal-ok");
  const passwordDialog = document.getElementById("password-dialog");
  const passwordForm = document.getElementById("password-form");
  const form = document.getElementById("app-form");
  const fieldsContainer = document.getElementById("modal-fields");
  const formError = document.getElementById("form-error");
  const toast = document.getElementById("toast");

  // Notifications elements
  const notificationsBtn = document.getElementById("notifications-btn");
  const notificationsDropdown = document.getElementById("notifications-dropdown");
  const notificationBadge = document.getElementById("notification-badge");
  const notificationsList = document.getElementById("notifications-list");
  const markNotificationsReadBtn = document.getElementById("mark-notifications-read");

  let activeDialogType = "";
  let selectedService = "";
  let currentUser = null;
  let authMode = "login";
  let toastTimer;
  let notificationsPollTimer;
  let wuOperation = "envoi";
  let mobileOperation = "envoi";

  const icons = {
    transfer: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 7h13m0 0-4-4m4 4-4 4M17 17H4m0 0 4-4m-4 4 4 4"/></svg>',
    request: '<svg viewBox="0 0 24 24" fill="none"><path d="M8 3h8l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3Zm7 1v5h5M8 13h8m-8 4h5"/></svg>',
  };

  const statuses = {
    pending: ["En attente", ""],
    prepared: ["Préparé", "status-prepared"],
    processing: ["En traitement", "status-processing"],
    completed: ["Terminé", "status-completed"],
    rejected: ["Refusé", "status-rejected"],
  };

  const escapeHTML = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (character) => ({
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
          ...(options.body && typeof options.body === "string" ? { "Content-Type": "application/json" } : {}),
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

  /* --- NOTIFICATIONS --- */
  async function loadNotifications() {
    if (!currentUser) return;
    try {
      const data = await api("/api/notifications");
      const unreadCount = data.unreadCount || 0;
      if (unreadCount > 0) {
        notificationBadge.hidden = false;
        notificationBadge.textContent = String(unreadCount);
      } else {
        notificationBadge.hidden = true;
      }

      if (!data.notifications || data.notifications.length === 0) {
        notificationsList.innerHTML = '<div class="notification-empty">Aucune notification pour le moment.</div>';
        return;
      }

      notificationsList.innerHTML = data.notifications.map((n) => {
        const dateStr = new Intl.DateTimeFormat("fr-FR", {
          dateStyle: "short",
          timeStyle: "short",
        }).format(new Date(n.createdAt));

        return `<div class="notification-item ${n.isRead ? "" : "unread"}" data-req-id="${escapeHTML(n.requestId)}">
          <span>${escapeHTML(n.message)}</span>
          <span class="notification-time">${dateStr}</span>
        </div>`;
      }).join("");

      notificationsList.querySelectorAll(".notification-item").forEach((el) => {
        el.addEventListener("click", () => {
          const reqId = el.dataset.reqId;
          notificationsDropdown.hidden = true;
          if (reqId) openRequestDetail(reqId);
        });
      });
    } catch {
      // Ignore background notification error
    }
  }

  if (notificationsBtn) {
    notificationsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isHidden = notificationsDropdown.hidden;
      notificationsDropdown.hidden = !isHidden;
      if (!notificationsDropdown.hidden) loadNotifications();
    });
  }

  if (markNotificationsReadBtn) {
    markNotificationsReadBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await api("/api/notifications/read", { method: "POST", body: "{}" });
        await loadNotifications();
        showToast("Toutes les notifications sont marquées comme lues.");
      } catch (err) {
        showToast(err.message);
      }
    });
  }

  document.addEventListener("click", (e) => {
    if (notificationsDropdown && !notificationsDropdown.hidden) {
      if (!notificationsDropdown.contains(e.target) && e.target !== notificationsBtn) {
        notificationsDropdown.hidden = true;
      }
    }
  });

  
  /* --- ADMIN CLIENTS OVERVIEW --- */
  async function loadAdminClients() {
    if (!currentUser || currentUser.role !== "admin") return;
    const section = document.getElementById("admin-clients-section");
    const countEl = document.getElementById("admin-clients-count");
    const tbody = document.getElementById("admin-clients-tbody");
    if (!section || !tbody) return;

    try {
      const { clients } = await api("/api/admin/users");
      countEl.textContent = `${clients.length} client${clients.length > 1 ? "s" : ""}`;
      if (!clients.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px; color: #94a3b8;">Aucun client enregistré pour le moment.</td></tr>';
        return;
      }
      tbody.innerHTML = clients.map((c) => {
        const dateStr = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" }).format(new Date(c.createdAt));
        return `<tr>
          <td><strong>${escapeHTML(c.name)}</strong></td>
          <td>${escapeHTML(c.email)}</td>
          <td>${dateStr}</td>
          <td><strong>${c.totalRequests}</strong></td>
          <td>${c.activeRequests ? `<span class="badge-num badge-num-active">${c.activeRequests}</span>` : "0"}</td>
          <td>${c.completedRequests ? `<span class="badge-num badge-num-completed">${c.completedRequests}</span>` : "0"}</td>
        </tr>`;
      }).join("");
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 20px; color: #ef4444;">Impossible de charger la liste : ${escapeHTML(err.message)}</td></tr>`;
    }
  }

  /* --- REQUEST DETAIL & TRACKING MODAL --- */
  async function openRequestDetail(requestId) {
    try {
      const { request } = await api(`/api/requests/${encodeURIComponent(requestId)}`);
      const isAdmin = currentUser && currentUser.role === "admin";
      const isWU = request.service === "Western Union";
      const isEnvoi = request.wuOperation === "envoi";
      const isRetrait = request.wuOperation === "retrait";

      const createdDate = new Intl.DateTimeFormat("fr-FR", {
        dateStyle: "long",
        timeStyle: "short",
      }).format(new Date(request.createdAt));

      const updatedDate = new Intl.DateTimeFormat("fr-FR", {
        dateStyle: "long",
        timeStyle: "short",
      }).format(new Date(request.updatedAt));

      // Tracking step progression
      const statusOrder = { pending: 1, prepared: 1, processing: 2, completed: 3, rejected: 3 };
      const currentStep = statusOrder[request.status] || 1;
      const isRejected = request.status === "rejected";

      const timelineHtml = `
        <div class="tracking-timeline">
          <div class="tracking-step ${currentStep >= 1 ? "done" : ""}">
            <div class="tracking-step-dot">1</div>
            <span>Demande transmise</span>
          </div>
          <div class="tracking-step ${currentStep > 2 ? "done" : currentStep === 2 ? "active" : ""}">
            <div class="tracking-step-dot">2</div>
            <span>En traitement agence</span>
          </div>
          <div class="tracking-step ${isRejected ? "rejected" : currentStep >= 3 ? "done" : ""}">
            <div class="tracking-step-dot">${isRejected ? "✕" : "3"}</div>
            <span>${isRejected ? "Demande refusée" : "Traitée & Validée"}</span>
          </div>
        </div>
      `;

      const [statusLabel, statusClass] = statuses[request.status] || statuses.pending;

      let specificDetailsHtml = "";
      const isMobile = request.service === "Mobile Money" || request.service === "Airtel Money";
      if (isMobile && request.wuOperation === "retrait") {
        specificDetailsHtml = `
          <div class="detail-item"><small>Service & Opération</small><strong>${escapeHTML(request.service)} · Retrait d'argent</strong></div>
          <div class="detail-item"><small>Montant</small><strong>${escapeHTML(request.amount)} ${escapeHTML(request.currency || "FCFA")}</strong></div>
          <div class="detail-item"><small>Bénéficiaire</small><strong>${escapeHTML(request.recipient)}</strong></div>
          <div class="detail-item"><small>Numéro de compte mobile</small><strong>${escapeHTML(request.phone)}</strong></div>
          <div class="detail-item"><small>Agence de retrait</small><strong>${escapeHTML(request.agency || "Non renseignée")}</strong></div>
        `;
      } else if (isWU) {
        if (isEnvoi) {
          const sendTypeLabel = request.sendType === "direct_to_bank" ? "Direct to Bank (Compte bancaire)" : "Envoi normal (Cash)";
          specificDetailsHtml = `
            <div class="detail-item"><small>Service & Opération</small><strong>Western Union · Envoi d'argent</strong></div>
            <div class="detail-item"><small>Type d'envoi</small><strong>${escapeHTML(sendTypeLabel)}</strong></div>
            <div class="detail-item"><small>Bénéficiaire</small><strong>${escapeHTML(request.recipient)}</strong></div>
            <div class="detail-item"><small>Pays de destination</small><strong>${escapeHTML(request.country)}</strong></div>
            <div class="detail-item"><small>Montant</small><strong>${escapeHTML(request.amount)} ${escapeHTML(request.currency)}</strong></div>
            <div class="detail-item"><small>Agence de prise en charge</small><strong>${escapeHTML(request.agency || "Non renseignée")}</strong></div>
            ${request.idDocument ? `
              <div class="detail-item" style="grid-column: 1 / -1;">
                <small>Pièce d'identité expéditeur</small>
                <a href="/api/uploads/${escapeHTML(request.idDocument)}" target="_blank" rel="noopener noreferrer" class="detail-doc-btn">
                  📄 Ouvrir la pièce jointe (CNI / Passeport)
                </a>
              </div>
            ` : ""}
          `;
        } else if (isRetrait) {
          specificDetailsHtml = `
            <div class="detail-item"><small>Service & Opération</small><strong>Western Union · Retrait d'argent</strong></div>
            <div class="detail-item"><small>Numéro MTCN</small><strong style="font-family: monospace; letter-spacing: 1px;">${escapeHTML(request.mtcn)}</strong></div>
            <div class="detail-item"><small>Nom du bénéficiaire</small><strong>${escapeHTML(request.recipient)}</strong></div>
            <div class="detail-item"><small>Agence de retrait choisie</small><strong>${escapeHTML(request.agency || "Non renseignée")}</strong></div>
          `;
        }
      } else {
        specificDetailsHtml = `
          <div class="detail-item"><small>Service</small><strong>${escapeHTML(request.service)}</strong></div>
          ${request.amount ? `<div class="detail-item"><small>Montant</small><strong>${escapeHTML(request.amount)} ${escapeHTML(request.currency)}</strong></div>` : ""}
          ${request.recipient ? `<div class="detail-item"><small>Bénéficiaire</small><strong>${escapeHTML(request.recipient)}</strong></div>` : ""}
          ${request.name ? `<div class="detail-item"><small>Nom</small><strong>${escapeHTML(request.name)}</strong></div>` : ""}
          ${request.phone ? `<div class="detail-item"><small>Téléphone</small><strong>${escapeHTML(request.phone)}</strong></div>` : ""}
          ${request.details ? `<div class="detail-item" style="grid-column: 1 / -1;"><small>Précisions</small><strong>${escapeHTML(request.details)}</strong></div>` : ""}
        `;
      }

      const clientInfoHtml = isAdmin ? `
        <div class="detail-item"><small>Client demandeur</small><strong>${escapeHTML(request.userName || "")} (${escapeHTML(request.email || "")})</strong></div>
      ` : "";

      const adminActionHtml = isAdmin ? `
        <div style="background: rgba(255,255,255,0.05); padding: 14px; border-radius: 10px; margin-top: 10px;">
          <small style="color: #94a3b8; display: block; margin-bottom: 8px; font-weight: 600; text-transform: uppercase;">Traitement Administrateur</small>
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <select id="modal-status-select" class="status-select" style="padding: 8px 12px; font-size: 13px;">
              ${Object.entries(statuses).map(([val, [txt]]) => `<option value="${val}" ${val === request.status ? "selected" : ""}>${txt}</option>`).join("")}
            </select>
            <button id="modal-status-save" class="button button-primary" type="button" style="padding: 8px 16px; font-size: 13px;">
              Mettre à jour le statut
            </button>
          </div>
        </div>
      ` : "";

      detailContent.innerHTML = `
        ${timelineHtml}
        <div class="detail-grid">
          <div class="detail-item"><small>N° de Demande</small><strong>${escapeHTML(request.id)}</strong></div>
          <div class="detail-item"><small>Statut actuel</small><span><span class="status-badge ${statusClass}">${statusLabel}</span></span></div>
          ${clientInfoHtml}
          ${specificDetailsHtml}
          <div class="detail-item"><small>Date d'envoi</small><strong>${createdDate}</strong></div>
          <div class="detail-item"><small>Dernière mise à jour</small><strong>${updatedDate}</strong></div>
        </div>
        ${adminActionHtml}
      `;

      if (isAdmin) {
        const saveBtn = document.getElementById("modal-status-save");
        const statusSel = document.getElementById("modal-status-select");
        if (saveBtn && statusSel) {
          saveBtn.addEventListener("click", async () => {
            saveBtn.disabled = true;
            try {
              await api(`/api/requests/${encodeURIComponent(request.id)}/status`, {
                method: "PATCH",
                body: JSON.stringify({ status: statusSel.value }),
              });
              showToast("Statut mis à jour avec succès et notification transmise au client.");
              await renderRequests();
              await openRequestDetail(request.id);
            } catch (err) {
              showToast(err.message);
              saveBtn.disabled = false;
            }
          });
        }
      }

      if (detailDialog) detailDialog.showModal();
    } catch (err) {
      showToast(err.message);
    }
  }

  if (detailClose) detailClose.addEventListener("click", () => detailDialog && detailDialog.close());
  if (detailOk) detailOk.addEventListener("click", () => detailDialog && detailDialog.close());

  /* --- RENDER REQUESTS LIST --- */
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

    requestList.innerHTML = items.slice(0, sessionUser.role === "admin" ? 200 : 20).map((item) => {
      const isTransfer = item.kind === "transfer";
      const label = isTransfer ? "Transfert" : "Demande";
      const date = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(new Date(item.createdAt));

      let detail = "";
      if (item.service === "Western Union") {
        if (item.wuOperation === "envoi") {
          detail = `Western Union (Envoi) · ${escapeHTML(item.amount)} ${escapeHTML(item.currency)} → ${escapeHTML(item.recipient)}`;
        } else if (item.wuOperation === "retrait") {
          detail = `Western Union (Retrait) · MTCN ${escapeHTML(item.mtcn)} · ${escapeHTML(item.agency)}`;
        } else {
          detail = `Western Union · ${escapeHTML(date)}`;
        }
      } else {
        detail = isTransfer
          ? `${escapeHTML(item.service)} · ${escapeHTML(item.amount)} ${escapeHTML(item.currency)}`
          : `${escapeHTML(item.service)} · ${escapeHTML(date)}`;
      }

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
        <span class="request-info">
          <strong>${label} · ${escapeHTML(item.id)}</strong>
          <span>${detail}</span>
          ${adminDetails}
        </span>
        <div class="request-actions-row">
          <button class="btn-action-view" type="button" data-view-id="${escapeHTML(item.id)}">
            Détails & Suivi
          </button>
          ${adminStatusControl || `<span class="status-badge ${statusClass}">${statusLabel}</span>`}
        </div>
      </div>`;
    }).join("");

    requestList.querySelectorAll("[data-view-id]").forEach((btn) => {
      btn.addEventListener("click", () => openRequestDetail(btn.dataset.viewId));
    });

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
    const titleEl = document.getElementById("auth-title");
    if (titleEl) {
      titleEl.innerHTML = registration
        ? "<span>Créer un compte client</span>"
        : '<span class="official-logo-clean" aria-label="Money Express"><img src="/assets/money-express-logo.jpg" alt="Money Express" /></span>';
    }
    document.getElementById("auth-description").textContent = registration
      ? "Créez votre compte client pour préparer et suivre vos demandes."
      : "Connectez-vous pour accéder à vos demandes et à vos services.";
    document.getElementById("auth-switch-copy").textContent = registration
      ? "Vous avez déjà un compte ?"
      : "Vous n’avez pas encore de compte ?";
    document.getElementById("auth-switch").textContent = registration ? "Se connecter" : "Créer un compte client";
    document.getElementById("auth-admin-note").hidden = registration;
    authSubmit.innerHTML = registration
      ? 'Créer mon compte <span aria-hidden="true">→</span>'
      : 'Se connecter <span aria-hidden="true">→</span>';
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
    if (notificationsPollTimer) clearInterval(notificationsPollTimer);
    appShell.hidden = true;
    authScreen.hidden = false;
    if (dialog && dialog.open) dialog.close();
    if (detailDialog && detailDialog.open) detailDialog.close();
    if (passwordDialog && passwordDialog.open) passwordDialog.close();
    const adminClientsSec = document.getElementById("admin-clients-section");
    if (adminClientsSec) adminClientsSec.hidden = true;
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
    const adminClientsSec = document.getElementById("admin-clients-section");
    if (adminClientsSec) adminClientsSec.hidden = !isAdmin;
    document.getElementById("requests-description").textContent = isAdmin
      ? "Consultez le contenu détaillé des demandes clients et traitez-les."
      : "Suivez ici le traitement et les étapes de vos demandes.";
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
    loadNotifications();
    if (isAdmin) loadAdminClients();

    if (notificationsPollTimer) clearInterval(notificationsPollTimer);
    notificationsPollTimer = setInterval(() => {
      loadNotifications();
      renderRequests();
    }, 20000);
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
    errorElement.textContent = "";
    if (!passwordForm.reportValidity()) return;
    const values = Object.fromEntries(new FormData(passwordForm).entries());
    if (values.newPassword !== values.confirmPassword) {
      errorElement.textContent = "La confirmation du mot de passe ne correspond pas.";
      return;
    }
    const submit = document.getElementById("password-submit");
    submit.disabled = true;
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        }),
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

  function field({ name, label, type = "text", placeholder = "", options = [], required = true, hint = "", full = false, min = "", maxLength = "", value = "" }) {
    const attr = `${required ? "required" : ""}${min ? ` min="${escapeHTML(min)}"` : ""}${maxLength ? ` maxlength="${escapeHTML(maxLength)}"` : ""}`;
    let control;
    if (type === "select") {
      control = `<select name="${escapeHTML(name)}" id="field-${escapeHTML(name)}" ${attr}>
        <option value="" disabled ${!value ? "selected" : ""}>Choisir une option</option>
        ${options.map((option) => `<option value="${escapeHTML(option)}" ${option === value ? "selected" : ""}>${escapeHTML(option)}</option>`).join("")}
      </select>`;
    } else if (type === "textarea") {
      control = `<textarea name="${escapeHTML(name)}" id="field-${escapeHTML(name)}" placeholder="${escapeHTML(placeholder)}" ${attr}>${escapeHTML(value)}</textarea>`;
    } else {
      control = `<input type="${escapeHTML(type)}" name="${escapeHTML(name)}" id="field-${escapeHTML(name)}" value="${escapeHTML(value)}" placeholder="${escapeHTML(placeholder)}" ${attr} autocomplete="${type === "tel" ? "tel" : "off"}" />`;
    }
    return `<div class="field-group${full ? " field-full" : ""}">
      <label for="field-${escapeHTML(name)}">${escapeHTML(label)}</label>${control}
      ${hint ? `<span class="field-hint">${escapeHTML(hint)}</span>` : ""}
    </div>`;
  }

    /* --- MOBILE MONEY & AIRTEL MONEY FIELDS RENDERER --- */
  function renderMobileFields(serviceName) {
    const isEnvoi = mobileOperation === "envoi";
    const agencyOptions = ["Agence Massengo", "Agence Kinsoudi", "Agence Mfilou"];

    const switcher = `
      <div class="field-full" style="margin-bottom: 12px;">
        <label style="display:block; font-size:12px; font-weight:600; color:#94a3b8; margin-bottom:6px;">TYPE D'OPÉRATION ${escapeHTML(serviceName).toUpperCase()}</label>
        <div class="wu-type-selector">
          <button type="button" class="wu-type-btn ${isEnvoi ? "active" : ""}" data-mobile-toggle="envoi">
            📤 Envoi / Dépôt
          </button>
          <button type="button" class="wu-type-btn ${!isEnvoi ? "active" : ""}" data-mobile-toggle="retrait">
            📥 Retrait en agence
          </button>
        </div>
        <input type="hidden" name="service" value="${escapeHTML(serviceName)}" />
        <input type="hidden" name="wu_operation" value="${mobileOperation}" />
      </div>
    `;

    let specificFields = "";
    if (isEnvoi) {
      specificFields = [
        field({ name: "amount", label: "Montant indicatif", type: "number", placeholder: "Ex. 50 000", min: "1" }),
        field({ name: "currency", label: "Devise", type: "select", options: ["FCFA", "EUR", "USD"], value: "FCFA" }),
        field({ name: "recipient", label: "Nom du destinataire", placeholder: "Nom complet" }),
        field({ name: "phone", label: "Numéro de téléphone destinataire", type: "tel", placeholder: "Ex. 06 XXX XX XX", full: true, hint: "Numéro de compte destinataire." }),
      ].join("");
    } else {
      specificFields = [
        field({ name: "recipient", label: "Nom complet du bénéficiaire", placeholder: "Votre nom complet", full: true }),
        field({ name: "phone", label: "Numéro de compte ${serviceName}", type: "tel", placeholder: "Ex. 06 XXX XX XX", full: true, hint: "Numéro à débiter ou associé au compte." }),
        field({ name: "amount", label: "Montant à retirer", type: "number", placeholder: "Ex. 25 000", min: "1" }),
        field({ name: "currency", label: "Devise", type: "select", options: ["FCFA", "EUR", "USD"], value: "FCFA" }),
        field({ name: "agency", label: "Agence de retrait souhaitée", type: "select", options: agencyOptions, value: "Agence Massengo", full: true }),
      ].join("");
    }

    fieldsContainer.innerHTML = switcher + specificFields;

    fieldsContainer.querySelectorAll("[data-mobile-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        mobileOperation = btn.dataset.mobileToggle;
        renderMobileFields(serviceName);
      });
    });
  }

  /* --- WESTERN UNION FIELDS RENDERER --- */
  function renderWuFields() {
    const isEnvoi = wuOperation === "envoi";
    const agencyOptions = ["Agence Massengo", "Agence Kinsoudi", "Agence Mfilou"];

    const switcher = `
      <div class="field-full" style="margin-bottom: 12px;">
        <label style="display:block; font-size:12px; font-weight:600; color:#94a3b8; margin-bottom:6px;">TYPE D'OPÉRATION WESTERN UNION</label>
        <div class="wu-type-selector">
          <button type="button" class="wu-type-btn ${isEnvoi ? "active" : ""}" data-wu-toggle="envoi">
            📤 Envoi d'argent
          </button>
          <button type="button" class="wu-type-btn ${!isEnvoi ? "active" : ""}" data-wu-toggle="retrait">
            📥 Retrait d'argent
          </button>
        </div>
        <input type="hidden" name="service" value="Western Union" />
        <input type="hidden" name="wu_operation" value="${wuOperation}" />
      </div>
    `;

    let specificFields = "";
    if (isEnvoi) {
      specificFields = [
        field({ name: "recipient", label: "Nom complet du bénéficiaire", placeholder: "Nom et prénom du destinataire", full: true }),
        field({ name: "country", label: "Pays du bénéficiaire", placeholder: "Ex. France, Cameroun, Sénégal, Canada..." }),
        field({ name: "amount", label: "Montant à envoyer", type: "number", placeholder: "Ex. 100 000", min: "1" }),
        field({ name: "currency", label: "Devise", type: "select", options: ["FCFA", "EUR", "USD"], value: "FCFA" }),
        field({ name: "send_type", label: "Type d'envoi", type: "select", options: ["Envoi normal (Cash to Cash)", "Direct to Bank (Vers compte bancaire)"], value: "Envoi normal (Cash to Cash)" }),
        field({ name: "agency", label: "Agence de dépôt / prise en charge", type: "select", options: agencyOptions, value: "Agence Massengo" }),
        `<div class="field-group field-full file-upload-container">
          <label for="id-document-file">Pièce d'identité de l'expéditeur (CNI ou Passeport)</label>
          <input type="file" id="id-document-file" name="id_document" class="file-upload-input" accept="image/png,image/jpeg,image/webp,application/pdf" required />
          <span class="field-hint">Fichier image (JPG, PNG, WebP) ou PDF (max. 5 Mo). Requis pour l'envoi.</span>
        </div>`,
      ].join("");
    } else {
      specificFields = [
        field({ name: "mtcn", label: "Numéro de transfert (MTCN)", placeholder: "Code MTCN (10 chiffres)", full: true }),
        field({ name: "recipient", label: "Nom du bénéficiaire (tel que sur le transfert)", placeholder: "Votre nom complet", full: true }),
        field({ name: "agency", label: "Agence de retrait souhaitée", type: "select", options: agencyOptions, value: "Agence Massengo", full: true }),
      ].join("");
    }

    fieldsContainer.innerHTML = switcher + specificFields;

    fieldsContainer.querySelectorAll("[data-wu-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        wuOperation = btn.dataset.wuToggle;
        renderWuFields();
      });
    });
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
      description.textContent = "Renseignez les informations utiles à votre opération Western Union ou autre.";
      icon.innerHTML = icons.transfer;
      submit.innerHTML = 'Enregistrer ma demande <span aria-hidden="true">→</span>';

      if (selectedService === "Western Union") {
        renderWuFields();
      } else if (selectedService === "Mobile Money" || selectedService === "Airtel Money") {
        renderMobileFields(selectedService);
      } else {
        const transferOptions = ["Western Union", "Express Union", "Mobile Money", "Airtel Money"];
        fieldsContainer.innerHTML = [
          field({ name: "service", label: "Service de transfert", type: "select", options: transferOptions, value: selectedService }),
          field({ name: "amount", label: "Montant indicatif", type: "number", placeholder: "Ex. 50 000", min: "1" }),
          field({ name: "currency", label: "Devise", type: "select", options: ["FCFA", "EUR", "USD"], value: "FCFA" }),
          field({ name: "recipient", label: "Nom du bénéficiaire", placeholder: "Nom et prénom" }),
          field({ name: "phone", label: "Téléphone du bénéficiaire", type: "tel", placeholder: "+237 …", full: true, hint: "Ne renseignez jamais un code secret ou mot de passe." }),
        ].join("");

        const serviceSelect = document.getElementById("field-service");
        if (serviceSelect) {
          serviceSelect.addEventListener("change", () => {
            if (serviceSelect.value === "Western Union") {
              selectedService = "Western Union";
              renderWuFields();
            } else if (serviceSelect.value === "Mobile Money" || serviceSelect.value === "Airtel Money") {
              selectedService = serviceSelect.value;
              renderMobileFields(selectedService);
            }
          });
        }
      }
    } else {
      title.textContent = "Faire une demande";
      description.textContent = "Décrivez votre besoin pour le transmettre de manière sécurisée à Money Express.";
      icon.innerHTML = icons.request;
      submit.innerHTML = 'Enregistrer ma demande <span aria-hidden="true">→</span>';

      if (selectedService === "Western Union") {
        activeDialogType = "transfer";
        renderWuFields();
      } else {
        const services = ["Billet d’avion", "Assurance automobile", "Offres NSIA", "Mobile Money", "Airtel Money", "Western Union", "Express Union", "Canal+ & CanalBox", "Autre demande"];
        fieldsContainer.innerHTML = [
          field({ name: "service", label: "Votre besoin", type: "select", options: services, value: selectedService }),
          field({ name: "name", label: "Votre nom", placeholder: "Nom et prénom", maxLength: "100" }),
          field({ name: "phone", label: "Téléphone", type: "tel", placeholder: "+237 …", full: true }),
          field({ name: "details", label: "Quelques précisions", type: "textarea", placeholder: "Votre destination, vos questions, les détails utiles…", required: false, full: true }),
        ].join("");

        const serviceSelect = document.getElementById("field-service");
        if (serviceSelect) {
          serviceSelect.addEventListener("change", () => {
            if (serviceSelect.value === "Western Union") {
              activeDialogType = "transfer";
              selectedService = "Western Union";
              renderWuFields();
            }
          });
        }
      }
    }

    dialog.showModal();
    const firstInput = dialog.querySelector("input:not([type=hidden]), select, textarea");
    if (firstInput) firstInput.focus();
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
    const submit = document.getElementById("modal-submit");
    submit.disabled = true;

    try {
      const isWu = selectedService === "Western Union" || (form.elements["service"] && form.elements["service"].value === "Western Union");
      const fileInput = form.querySelector("input[type=file]");
      if (fileInput && fileInput.files && fileInput.files[0]) {
        const file = fileInput.files[0];
        if (file.size > 5 * 1024 * 1024) {
          formError.textContent = "Le fichier sélectionné est trop lourd (" + (file.size / (1024 * 1024)).toFixed(1) + " Mo). La taille maximale autorisée est de 5 Mo.";
          submit.disabled = false;
          return;
        }
      }
      const hasFileInput = Boolean(fileInput);

      let createdRequest;

      if (isWu || hasFileInput) {
        const formData = new FormData(form);
        formData.set("kind", isTransfer ? "transfer" : "request");
        if (formData.get("send_type")) {
          const rawType = formData.get("send_type");
          formData.set("send_type", rawType.includes("Direct to Bank") ? "direct_to_bank" : "normal");
        }

        const res = await fetch("/api/requests", {
          method: "POST",
          body: formData,
          credentials: "same-origin",
        });
        const resData = await res.json();
        if (!res.ok) throw new Error(resData.error || "Erreur lors de la transmission");
        createdRequest = resData.request;
      } else {
        const data = Object.fromEntries(new FormData(form).entries());
        data.kind = isTransfer ? "transfer" : "request";
        const resData = await api("/api/requests", {
          method: "POST",
          body: JSON.stringify(data),
        });
        createdRequest = resData.request;
      }

      closeModal();
      await renderRequests();
      await loadNotifications();

      const notifMsg = isWu
        ? `Demande Western Union ${createdRequest.id} envoyée avec succès !`
        : isTransfer
          ? `Préparation ${createdRequest.id} transmise à Money Express.`
          : `Demande ${createdRequest.id} transmise à Money Express.`;

      showToast(notifMsg);
      document.getElementById("demandes").scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (error) {
      formError.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }

  authForm.addEventListener("submit", submitAuth);
  document.getElementById("auth-switch").addEventListener("click", () => {
    setAuthMode(authMode === "login" ? "register" : "login");
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

  document.querySelectorAll("[data-open-modal]").forEach((button) => {
    button.addEventListener("click", () => openModal(button.dataset.openModal));
  });
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  form.addEventListener("submit", onSubmit);

  document.querySelectorAll("[data-service]").forEach((button) => {
    button.addEventListener("click", () => {
      const s = button.dataset.service;
      if (["Western Union", "Express Union", "Mobile Money", "Airtel Money"].includes(s)) {
        openModal("transfer", s);
      } else {
        openModal("request", s);
      }
    });
  });

  document.querySelectorAll(".support-action").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (WHATSAPP_NUMBER) {
        window.open(`https://wa.me/${WHATSAPP_NUMBER}`, "_blank", "noopener,noreferrer");
      } else {
        openModal("request", "Autre demande");
      }
    });
  });

  document.querySelectorAll("[href='#fidelite']").forEach((link) => {
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

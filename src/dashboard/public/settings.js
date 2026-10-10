(() => {
  const root = document.querySelector('[data-guild-id]');
  const form = document.querySelector('#settings-form');
  if (!root || !form) return;

  const guildId = root.dataset.guildId;
  const section = root.dataset.section;
  const notice = document.querySelector('#notice');

  async function readApiJson(response) {
    try {
      return await response.json();
    } catch {
      throw new Error(`Dashboard API returned an invalid response (HTTP ${response.status}). Check the dashboard server terminal for details.`);
    }
  }

  function splitList(value) {
    return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  }

  function parseRecords(value, type) {
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.map((line, index) => {
      const values = line.split('|').map((part) => part.trim());
      if (type === 'roleReward' && values.length === 2) {
        const level = Number(values[0]);
        if (!Number.isSafeInteger(level) || !values[1]) throw new Error(`Role reward on line ${index + 1} must be “level | role ID”.`);
        return { level, roleId: values[1] };
      }
      if (type === 'shop' && values.length === 4) {
        const price = Number(values[3]);
        if (!Number.isSafeInteger(price)) throw new Error(`Shop item on line ${index + 1} must have an integer price.`);
        return { itemId: values[0], name: values[1], description: values[2], price };
      }
      if (type === 'ticketCategory' && values.length === 5) {
        return {
          key: values[0],
          label: values[1],
          description: values[2],
          categoryId: values[3] || null,
          supportRoleId: values[4] || null,
        };
      }
      throw new Error(`Line ${index + 1} has an invalid format.`);
    });
  }

  function settingValues() {
    const values = {};
    for (const input of form.querySelectorAll('[data-setting-key]')) {
      const key = input.dataset.settingKey;
      const type = input.dataset.settingType;
      if (type === 'checkbox') values[key] = input.checked;
      else if (type === 'number') {
        if (!input.value.trim()) throw new Error(`${input.closest('.field').querySelector('span').textContent} is required.`);
        values[key] = Number(input.value);
        if (!Number.isSafeInteger(values[key])) throw new Error(`${input.closest('.field').querySelector('span').textContent} must be a whole number.`);
      } else if (type === 'id') values[key] = input.value.trim() || null;
      else if (type === 'lines') values[key] = input.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      else if (type === 'records') values[key] = parseRecords(input.value, input.dataset.recordType);
      else values[key] = input.value.trim();
    }
    return values;
  }

  function welcomeValues() {
    const welcomeLeave = {
      welcomeEnabled: form.querySelector('[data-welcome-enabled]').checked,
      leaveEnabled: form.querySelector('[data-leave-enabled]').checked,
      welcomeChannelId: form.querySelector('[data-welcome-channel]').value.trim() || null,
      leaveChannelId: form.querySelector('[data-leave-channel]').value.trim() || null,
      backgroundImageUrl: form.querySelector('[data-background-image]').value.trim() || null,
      welcome: {},
      leave: {},
    };
    for (const input of form.querySelectorAll('[data-embed-field]')) {
      const [type, key] = input.dataset.embedField.split('.');
      if (input.type === 'checkbox') welcomeLeave[type][key] = input.checked;
      else welcomeLeave[type][key] = input.value.trim() || (['thumbnailUrl', 'imageUrl'].includes(key) ? null : '');
    }
    return welcomeLeave;
  }

  function panelValues() {
    const panel = {};
    for (const input of form.querySelectorAll('[data-panel-field]')) {
      const key = input.dataset.panelField;
      panel[key] = input.value.trim() || (key === 'imageUrl' ? null : '');
    }
    return panel;
  }

  function commandPolicies() {
    return [...form.querySelectorAll('[data-command-card]')].map((card) => {
      const value = (name) => card.querySelector(`[data-command-field="${name}"]`);
      const parseNumber = (name, emptyValue = 0) => {
        const input = value(name);
        if (!input.value.trim()) return emptyValue;
        const number = Number(input.value);
        if (!Number.isSafeInteger(number)) throw new Error(`${card.dataset.commandName}: ${name} must be a whole number.`);
        return number;
      };
      return {
        commandName: card.dataset.commandName,
        enabled: value('enabled').checked,
        cooldownSeconds: parseNumber('cooldownSeconds'),
        maxUses: parseNumber('maxUses', null),
        windowSeconds: parseNumber('windowSeconds', 86400),
        requiredRoleIds: splitList(value('requiredRoleIds').value),
        allowedChannelIds: splitList(value('allowedChannelIds').value),
        deniedChannelIds: splitList(value('deniedChannelIds').value),
      };
    });
  }

  function moduleValues() {
    const modules = {};
    form.querySelectorAll('[data-module-toggle]').forEach((toggle) => {
      modules[toggle.value] = toggle.checked;
    });
    return modules;
  }

  function updatePreview(input) {
    const [type, field] = input.dataset.embedField.split('.');
    const preview = document.querySelector(`[data-preview="${type}"]`);
    if (!preview) return;
    if (field === 'color') preview.style.setProperty('--embed-color', input.value);
    else if (field === 'thumbnailUrl' || field === 'imageUrl') {
      const image = preview.querySelector(field === 'thumbnailUrl' ? '[data-preview-thumbnail]' : '[data-preview-image]');
      if (input.value.trim()) {
        image.src = input.value.trim();
        image.hidden = false;
      } else {
        image.removeAttribute('src');
        image.hidden = true;
      }
    } else {
      const target = preview.querySelector(`[data-preview-${field}]`);
      if (target) target.textContent = input.value;
    }
  }

  document.querySelectorAll('[data-embed-field]').forEach((input) => {
    input.addEventListener('input', () => updatePreview(input));
    updatePreview(input);
  });
  document.querySelectorAll('[data-panel-field]').forEach((input) => {
    input.addEventListener('input', () => {
      const preview = document.querySelector('[data-panel-preview]');
      if (!preview) return;
      if (input.dataset.panelField === 'color') preview.style.setProperty('--embed-color', input.value);
      else {
        const target = preview.querySelector(`[data-preview-${input.dataset.panelField}]`);
        if (target) target.textContent = input.value;
      }
    });
  });
  const backgroundImage = document.querySelector('[data-background-image]');
  if (backgroundImage) {
    const bannerPreview = document.querySelector('[data-banner-preview]');
    const updateBannerPreview = () => {
      if (backgroundImage.value.trim()) {
        bannerPreview.src = backgroundImage.value.trim();
        bannerPreview.hidden = false;
      } else {
        bannerPreview.removeAttribute('src');
        bannerPreview.hidden = true;
      }
    };
    backgroundImage.addEventListener('input', updateBannerPreview);
    updateBannerPreview();
  }

  const search = document.querySelector('[data-command-search]');
  if (search) {
    search.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase();
      document.querySelectorAll('[data-command-card]').forEach((card) => {
        card.hidden = !card.dataset.search.includes(query);
      });
    });
  }

  async function callDashboardAction(type, payload) {
    const response = await fetch(`/api/servers/${guildId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ type, payload }),
    });
    const action = await readApiJson(response);
    if (!response.ok) throw new Error(action.error || 'Could not queue dashboard action.');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const statusResponse = await fetch(`/api/servers/${guildId}/actions/${action.actionId}`, { credentials: 'same-origin' });
      const status = await readApiJson(statusResponse);
      if (!statusResponse.ok) throw new Error(status.error || 'Could not read dashboard action status.');
      if (status.status === 'completed') return status.result;
      if (status.status === 'failed') throw new Error(status.error || 'Bot action failed.');
    }
    throw new Error('The bot has not processed this request yet. Confirm the bot is online, then refresh and try again.');
  }

  async function saveThenDeploy() {
    const isTicket = section === 'ticketPanel';
    const kind = isTicket ? 'tickets' : 'verification';
    const settings = { [kind]: isTicket ? { panel: panelValues() } : {
      enabled: form.querySelector('[data-verification-enabled]').checked,
      roleId: form.querySelector('[data-verification-role]').value.trim() || null,
      channelId: form.querySelector('[data-deploy-channel]').value.trim() || null,
      panel: panelValues(),
    } };
    const configResponse = await fetch(`/api/servers/${guildId}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        modules: isTicket ? { tickets: true } : { verification: true },
        settings,
      }),
    });
    const configResult = await readApiJson(configResponse);
    if (!configResponse.ok) throw new Error(configResult.error || 'Could not save panel settings.');
    return callDashboardAction(
      isTicket ? 'deploy-ticket-panel' : 'deploy-verification-panel',
      { channelId: form.querySelector('[data-deploy-channel]').value.trim() },
    );
  }

  const musicPanel = document.querySelector('[data-music-panel]');
  if (musicPanel) {
    const setMusicNotice = (message, error = false) => {
      const target = musicPanel.querySelector('[data-music-notice]');
      target.className = error ? 'notice error' : 'notice';
      target.textContent = message;
    };
    const renderMusicState = (state) => {
      musicPanel.querySelector('[data-music-status]').textContent = state.status || 'idle';
      musicPanel.querySelector('[data-music-title]').textContent = state.current?.title || 'No track playing';
      musicPanel.querySelector('[data-music-channel]').textContent = state.voiceChannelId ? `Voice channel ${state.voiceChannelId}` : '';
      musicPanel.querySelector('[data-music-queue]').replaceChildren();
      if (!state.upcoming?.length) {
        const item = document.createElement('li');
        item.textContent = 'Queue is empty.';
        musicPanel.querySelector('[data-music-queue]').append(item);
      } else {
        state.upcoming.forEach((track) => {
          const item = document.createElement('li');
          item.textContent = track.title;
          musicPanel.querySelector('[data-music-queue]').append(item);
        });
      }
      musicPanel.querySelector('[data-music-volume]').value = state.volume ?? 50;
    };
    musicPanel.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-music-action]');
      if (!button) return;
      const operation = button.dataset.musicAction;
      setMusicNotice(operation === 'status' ? 'Refreshing player status…' : `Running ${operation}…`);
      try {
        const payload = { operation };
        if (operation === 'play') payload.query = musicPanel.querySelector('[data-music-query]').value.trim();
        if (operation === 'volume') payload.volume = Number(musicPanel.querySelector('[data-music-volume]').value);
        const result = await callDashboardAction('music', payload);
        if (operation === 'status') renderMusicState(result);
        else {
          setMusicNotice(result.message || 'Music action completed.');
          const state = await callDashboardAction('music', { operation: 'status' });
          renderMusicState(state);
        }
      } catch (error) {
        setMusicNotice(error.message, true);
      }
    });
    void callDashboardAction('music', { operation: 'status' })
      .then(renderMusicState)
      .catch((error) => setMusicNotice(error.message, true));
  }

  const scheduledList = document.querySelector('[data-schedule-list]');
  const scheduledNotice = document.querySelector('[data-scheduled-notice]');
  if (scheduledList) {
    const setScheduleNotice = (message, error = false) => {
      scheduledNotice.className = error ? 'notice error' : 'notice';
      scheduledNotice.textContent = message;
    };
    const refreshSchedules = async () => {
      const response = await fetch(`/api/servers/${guildId}/scheduled-messages`, { credentials: 'same-origin' });
      const result = await readApiJson(response);
      if (!response.ok) throw new Error(result.error || 'Could not load schedules.');
      scheduledList.replaceChildren();
      if (!result.messages.length) {
        const empty = document.createElement('p');
        empty.textContent = 'No scheduled messages yet.';
        scheduledList.append(empty);
        return;
      }
      result.messages.forEach((message) => {
        const row = document.createElement('div');
        row.className = 'schedule-row';
        const details = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = message.title || 'Untitled embed';
        const meta = document.createElement('small');
        meta.textContent = `${message.status} · <#${message.channelId}> · ${new Date(message.scheduledAt).toLocaleString()}`;
        details.append(title, meta);
        row.append(details);
        if (message.status === 'pending') {
          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.className = 'secondary';
          cancel.textContent = 'Cancel';
          cancel.addEventListener('click', async () => {
            try {
              const deleteResponse = await fetch(`/api/servers/${guildId}/scheduled-messages/${message._id}`, {
                method: 'DELETE', credentials: 'same-origin',
              });
              if (!deleteResponse.ok) {
                const error = await deleteResponse.json();
                throw new Error(error.error || 'Could not cancel schedule.');
              }
              await refreshSchedules();
            } catch (error) {
              setScheduleNotice(error.message, true);
            }
          });
          row.append(cancel);
        }
        scheduledList.append(row);
      });
    };
    document.querySelector('[data-scheduled-refresh]').addEventListener('click', () => {
      void refreshSchedules().catch((error) => setScheduleNotice(error.message, true));
    });
    document.querySelectorAll('[data-scheduled-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        setScheduleNotice(button.dataset.scheduledAction === 'send' ? 'Sending embed…' : 'Scheduling embed…');
        try {
          const embed = {};
          document.querySelectorAll('[data-scheduled-field]').forEach((input) => {
            embed[input.dataset.scheduledField] = input.value.trim();
          });
          const payload = {
            channelId: document.querySelector('[data-scheduled-channel]').value.trim(),
            embed,
            sendNow: button.dataset.scheduledAction === 'send',
          };
          if (!payload.sendNow) {
            const scheduledAt = document.querySelector('[data-scheduled-at]').value;
            if (!scheduledAt) throw new Error('Choose a schedule time.');
            payload.scheduledAt = new Date(scheduledAt).toISOString();
          }
          if (payload.sendNow) {
            const result = await callDashboardAction('send-embed', { channelId: payload.channelId, embed });
            setScheduleNotice(`Embed sent to channel ${result.channelId}.`);
          } else {
            const response = await fetch(`/api/servers/${guildId}/scheduled-messages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify(payload),
            });
            const result = await readApiJson(response);
            if (!response.ok) throw new Error(result.error || 'Could not schedule embed.');
            setScheduleNotice('Embed scheduled successfully.');
          }
          await refreshSchedules();
        } catch (error) {
          setScheduleNotice(error.message, true);
        }
      });
    });
    void refreshSchedules().catch((error) => setScheduleNotice(error.message, true));
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    notice.className = 'notice';
    notice.textContent = 'Saving changes…';
    try {
      const payload = {};
      if (section === 'general') {
        payload.prefix = form.elements.prefix.value.trim();
        payload.language = form.elements.language.value;
        payload.modules = {};
        form.querySelectorAll('input[name="module"]').forEach((input) => {
          payload.modules[input.value] = input.checked;
        });
      } else if (section === 'welcome') {
        payload.modules = moduleValues();
        payload.settings = { welcomeLeave: welcomeValues() };
      } else if (section === 'commands') {
        payload.commandPermissions = commandPolicies();
      } else if (section === 'ticketPanel' || section === 'verificationPanel') {
        const result = await saveThenDeploy();
        notice.className = 'notice success';
        notice.textContent = `Panel deployed to channel ${result.channelId}.`;
        return;
      } else {
        const modules = moduleValues();
        if (Object.keys(modules).length) payload.modules = modules;
        const settings = settingValues();
        if (Object.keys(settings).length) payload.settings = { [section]: settings };
      }

      const response = await fetch(`/api/servers/${guildId}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const result = await readApiJson(response);
      if (!response.ok) throw new Error(result.error || 'Could not save settings.');
      notice.className = 'notice success';
      notice.textContent = 'Your settings have been saved.';
    } catch (error) {
      notice.className = 'notice error';
      notice.textContent = error.message;
    }
  });
})();

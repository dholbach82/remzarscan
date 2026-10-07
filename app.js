"use strict";

(() => {
  const CONFIG = Object.freeze({
    apiBaseUrl: "http://127.0.0.1:8787/api/v1",
    pageSize: 20,
    decimals: 8,
    timeoutMs: 12000,
    staleAfterSeconds: 180,
    maxResponseBytes: 8 * 1024 * 1024,
    maxDisplayedBlocks: 200,
  });

  const $ = (id) => {
    const element = document.getElementById(id);

    if (!element) {
      throw new Error(`Missing page element: ${id}`);
    }

    return element;
  };

  const ui = {
    connection: $("connection-status"),
    connectionLabel: $("connection-label"),
    updated: $("last-updated"),
    notice: $("api-notice"),
    height: $("latest-height"),
    age: $("latest-block-age"),
    time: $("latest-block-time"),
    searchForm: $("search-form"),
    searchInput: $("block-search"),
    searchButton: $("search-button"),
    clearSearch: $("clear-search"),
    searchMessage: $("search-message"),
    searchResult: $("search-result"),
    searchContent: $("search-result-content"),
    interval: $("refresh-interval"),
    refresh: $("refresh-button"),
    tableRegion: $("blocks-table-region"),
    body: $("blocks-body"),
    summary: $("blocks-summary"),
    older: $("load-older-button"),
    template: $("block-details-template"),
    copyFeedback: $("copy-feedback"),
  };

  const state = {
    blocks: [],
    tipHash: null,
    nextBefore: null,
    paginationNeedsRefresh: false,
    latestTimestamp: null,
    lastSuccess: null,
    connection: "disconnected",
    listBusy: false,
    searchBusy: false,
    searchVersion: 0,
    searchController: null,
    timer: null,
    controllers: new Set(),
  };

  class ExplorerError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.name = "ExplorerError";
      this.status = status;
    }
  }

  function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ExplorerError(`Invalid API data: ${label}.`);
    }

    return value;
  }

  function unsigned(value, label) {
    let result;

    if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
      result = value;
    } else if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      result = String(value);
    } else {
      throw new ExplorerError(`Invalid API integer: ${label}.`);
    }

    if (result.length > 20 || BigInt(result) > 18446744073709551615n) {
      throw new ExplorerError(`API integer out of range: ${label}.`);
    }

    return result;
  }

  function hash(value, label) {
    if (typeof value !== "string" || !/^[a-f0-9]{128}$/i.test(value)) {
      throw new ExplorerError(`Invalid API hash: ${label}.`);
    }

    return value.toLowerCase();
  }

  function unixTime(value, label) {
    const seconds = unsigned(value, label);

    if (BigInt(seconds) > 8640000000000n) {
      throw new ExplorerError(`Invalid API timestamp: ${label}.`);
    }

    return Number(seconds);
  }

  function publicText(value, label) {
    if (typeof value !== "string" || value.length > 16384) {
      throw new ExplorerError(`Invalid API text: ${label}.`);
    }

    return value;
  }

  function normalizeBlock(raw) {
    const value = object(raw, "block");

    return {
      height: unsigned(value.height, "height"),
      timestamp: unixTime(value.timestamp, "timestamp"),
      hash: hash(value.hash, "hash"),
      parentHash: hash(value.parent_hash, "parent_hash"),
      transactionCount: unsigned(
        value.transaction_count,
        "transaction_count"
      ),
      rewardAtomic: unsigned(value.reward_atomic, "reward_atomic"),
    };
  }

  function normalizeDetails(raw) {
    const value = object(raw, "block details");
    const block = normalizeBlock(value);

    if (value.canonical !== true) {
      throw new ExplorerError(
        "This block is no longer on the connected node’s canonical chain.",
        409
      );
    }

    if (
      !Array.isArray(value.transactions) ||
      BigInt(value.transactions.length) !== BigInt(block.transactionCount)
    ) {
      throw new ExplorerError(
        "The API returned incomplete transaction details."
      );
    }

    return {
      ...block,
      merkleRoot: hash(value.merkle_root, "merkle_root"),
      miner: publicText(value.miner, "miner"),
      transactions: value.transactions.map((transaction) => {
        const tx = object(transaction, "transaction");

        publicText(tx.type, "transaction type");

        if (tx.amount_atomic !== undefined) {
          unsigned(tx.amount_atomic, "transaction amount");
        }

        if (tx.timestamp !== undefined) {
          unixTime(tx.timestamp, "transaction timestamp");
        }

        return tx;
      }),
    };
  }

  function normalizePage(raw, older) {
    const value = object(raw, "block page");
    const tipHeight = unsigned(value.tip_height, "tip_height");
    const tipHash = hash(value.tip_hash, "tip_hash");

    if (
      !Array.isArray(value.blocks) ||
      value.blocks.length === 0 ||
      value.blocks.length > CONFIG.pageSize
    ) {
      throw new ExplorerError("The API returned an invalid block page.");
    }

    const blocks = value.blocks.map(normalizeBlock);

    for (let index = 1; index < blocks.length; index += 1) {
      const newer = blocks[index - 1];
      const previous = blocks[index];

      if (
        BigInt(newer.height) !== BigInt(previous.height) + 1n ||
        newer.parentHash !== previous.hash
      ) {
        throw new ExplorerError(
          "The API returned a block page with inconsistent parent links."
        );
      }
    }

    if (older) {
      const previousLast = state.blocks[state.blocks.length - 1];

      if (
        tipHash !== state.tipHash ||
        tipHeight !== state.blocks[0].height ||
        blocks[0].height !==
          String(BigInt(state.nextBefore) - 1n) ||
        previousLast.parentHash !== blocks[0].hash
      ) {
        throw new ExplorerError(
          "The chain view changed. Refresh before loading older blocks.",
          409
        );
      }
    } else if (
      blocks[0].height !== tipHeight ||
      blocks[0].hash !== tipHash
    ) {
      throw new ExplorerError(
        "The API’s latest block does not match its reported tip."
      );
    }

    const last = blocks[blocks.length - 1];
    const nextBefore =
      value.next_before === null
        ? null
        : unsigned(value.next_before, "next_before");

    if (
      (last.height === "0" && nextBefore !== null) ||
      (last.height !== "0" && nextBefore !== last.height)
    ) {
      throw new ExplorerError("The API returned an invalid page cursor.");
    }

    return { tipHash, blocks, nextBefore };
  }

  function formatInteger(value) {
    return BigInt(value).toLocaleString("en-US");
  }

  function formatAmount(value) {
    const digits = unsigned(value, "amount").padStart(
      CONFIG.decimals + 1,
      "0"
    );

    const whole = digits.slice(0, -CONFIG.decimals);
    const fraction = digits.slice(-CONFIG.decimals).replace(/0+$/, "");

    return `${formatInteger(whole)}${fraction ? `.${fraction}` : ""}`;
  }

  function isoTime(seconds) {
    return new Date(seconds * 1000).toISOString();
  }

  function displayTime(seconds) {
    return isoTime(seconds).replace("T", " ").replace(".000Z", " UTC");
  }

  function setTime(element, seconds) {
    element.dateTime = isoTime(seconds);
    element.textContent = displayTime(seconds);
  }

  function relativeAge(seconds) {
    if (seconds < 0) {
      return "Timestamp is ahead of this device";
    }

    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;

    if (seconds < 86400) {
      return `${Math.floor(seconds / 3600)}h ${Math.floor(
        (seconds % 3600) / 60
      )}m ago`;
    }

    return `${Math.floor(seconds / 86400)}d ${Math.floor(
      (seconds % 86400) / 3600
    )}h ago`;
  }

  function updateAge() {
    if (state.latestTimestamp === null) return;

    const age = Math.floor(Date.now() / 1000) - state.latestTimestamp;
    ui.age.textContent = relativeAge(age);

    if (state.connection !== "connected") return;

    const stale = age > CONFIG.staleAfterSeconds || age < -60;
    ui.connection.dataset.state = stale ? "stale" : "connected";
    ui.connectionLabel.textContent = stale
      ? "API connected · check block age"
      : "API connected";
  }

  function setConnection(value) {
    state.connection = value;
    ui.connection.dataset.state = value;

    const labels = {
      disconnected: "Not connected",
      connecting: "Connecting",
      connected: "API connected",
      offline: "API unreachable",
      error: "API data unavailable",
    };

    ui.connectionLabel.textContent = labels[value] || "Status unknown";
    updateAge();
  }

  function showNotice(message, kind = "warning") {
    ui.notice.textContent = message;
    ui.notice.className = `notice notice-${kind}`;
    ui.notice.hidden = false;
  }

  function clearNotice() {
    ui.notice.hidden = true;
    ui.notice.textContent = "";
  }

  function updateControls() {
    ui.refresh.disabled = state.listBusy;
    ui.interval.disabled = false;
    ui.tableRegion.setAttribute("aria-busy", String(state.listBusy));

    ui.older.disabled =
      state.listBusy ||
      state.paginationNeedsRefresh ||
      state.nextBefore === null ||
      state.blocks.length >= CONFIG.maxDisplayedBlocks;

    ui.searchButton.disabled = state.searchBusy;

    if (state.blocks.length === 0) {
      ui.summary.textContent = state.listBusy
        ? "Loading blocks…"
        : "No blocks loaded";
      return;
    }

    const first = state.blocks[0];
    const last = state.blocks[state.blocks.length - 1];

    let summary =
      `${state.blocks.length} blocks shown · ` +
      `#${formatInteger(first.height)} to #${formatInteger(last.height)}`;

    if (state.paginationNeedsRefresh) {
      summary += " · Refresh required to load older blocks";
    } else if (state.nextBefore === null && last.height === "0") {
      summary += " · Beginning of chain";
    } else if (state.blocks.length >= CONFIG.maxDisplayedBlocks) {
      summary += " · Use search to inspect earlier heights";
    }

    ui.summary.textContent = summary;
  }

  function apiUrl(path, parameters = {}) {
    const base = new URL(CONFIG.apiBaseUrl, window.location.href);

    if (!["http:", "https:"].includes(base.protocol)) {
      throw new ExplorerError("The API address must use HTTP or HTTPS.");
    }

    if (
      window.location.protocol === "https:" &&
      base.protocol !== "https:"
    ) {
      throw new ExplorerError(
        "This HTTPS website requires an HTTPS API address."
      );
    }

    if (base.username || base.password) {
      throw new ExplorerError("Do not include credentials in the API URL.");
    }

    base.pathname =
      base.pathname.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
    base.search = "";
    base.hash = "";

    for (const [key, value] of Object.entries(parameters)) {
      base.searchParams.set(key, String(value));
    }

    return base;
  }

  async function readJson(response) {
    const lengthHeader = response.headers.get("content-length");

    if (
      lengthHeader !== null &&
      Number(lengthHeader) > CONFIG.maxResponseBytes
    ) {
      throw new ExplorerError("The API response exceeds the size limit.");
    }

    const contentType = response.headers.get("content-type") || "";

    if (!/\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(contentType)) {
      throw new ExplorerError(
        "The API returned a non-JSON response. Check its configured address."
      );
    }

    if (!response.body) {
      throw new ExplorerError("The API returned an empty response.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        size += value.byteLength;

        if (size > CONFIG.maxResponseBytes) {
          await reader.cancel();
          throw new ExplorerError(
            "The API response exceeds the size limit."
          );
        }

        text += decoder.decode(value, { stream: true });
      }

      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new ExplorerError("The API returned invalid JSON.");
    }
  }

  async function request(path, parameters = {}, externalSignal) {
    const controller = new AbortController();
    state.controllers.add(controller);

    let timedOut = false;
    const cancel = () => controller.abort();

    if (externalSignal) {
      externalSignal.addEventListener("abort", cancel, { once: true });
      if (externalSignal.aborted) controller.abort();
    }

    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CONFIG.timeoutMs);

    try {
      const response = await fetch(apiUrl(path, parameters), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });

      if (!response.ok) {
        const messages = {
          404: "Block not found.",
          409: "The chain view changed. Refresh and try again.",
          429: "The API is busy. Please try again shortly.",
          503: "The node cannot currently provide block data.",
        };

        throw new ExplorerError(
          messages[response.status] ||
            `The API returned HTTP ${response.status}.`,
          response.status
        );
      }

      return await readJson(response);
    } catch (error) {
      if (externalSignal?.aborted) {
        throw new DOMException("Request cancelled", "AbortError");
      }

      if (timedOut) {
        throw new ExplorerError("The API request timed out.");
      }

      if (error instanceof ExplorerError) throw error;
      if (error?.name === "AbortError") throw error;

      throw new ExplorerError(
        "Cannot reach the API. Check its address, HTTPS, and CORS configuration."
      );
    } finally {
      window.clearTimeout(timeout);
      state.controllers.delete(controller);
      externalSignal?.removeEventListener("abort", cancel);
    }
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);

    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;

    return node;
  }

  function cell(row, text, className) {
    const node = element("td", text, className);
    row.append(node);
    return node;
  }

  async function copyText(value, button) {
    try {
      if (!navigator.clipboard || !window.isSecureContext) {
        throw new Error("Clipboard unavailable");
      }

      await navigator.clipboard.writeText(value);
      button.textContent = "Copied";
      ui.copyFeedback.textContent = "Copied to clipboard.";

      window.setTimeout(() => {
        button.textContent = "Copy";
      }, 1500);
    } catch {
      ui.copyFeedback.textContent =
        "Copy failed. Select the full value and copy it manually.";
      button.textContent = "Select to copy";
    }
  }

  function addTransactionField(list, label, value, monospace = false) {
    const group = element("div");
    const term = element("dt", label);
    const description = element("dd");

    description.append(
      element(monospace ? "code" : "span", value)
    );

    group.append(term, description);
    list.append(group);
  }

  function renderTransaction(transaction) {
    const item = element("li");
    const fields = element("dl");

    addTransactionField(fields, "Type", transaction.type);

    const labels = {
      hash: "Transaction hash",
      sender: "Sender",
      receiver: "Receiver",
      amount_atomic: "Amount (REMZAR)",
      timestamp: "Timestamp (UTC)",
    };

    for (const [key, value] of Object.entries(transaction)) {
      if (key === "type" || value === null) continue;

      let displayed;

      if (key === "amount_atomic") {
        displayed = formatAmount(value);
      } else if (key === "timestamp") {
        displayed = displayTime(unixTime(value, "transaction timestamp"));
      } else if (typeof value === "object") {
        displayed = JSON.stringify(value, null, 2);
      } else {
        displayed = String(value);
      }

      addTransactionField(
        fields,
        labels[key] || key.replace(/_/g, " "),
        displayed,
        key === "hash" ||
          key === "sender" ||
          key === "receiver" ||
          typeof value === "object"
      );
    }

    item.append(fields);
    return item;
  }

  function renderDetails(block) {
    const fragment = ui.template.content.cloneNode(true);
    const article = fragment.querySelector(".block-details");

    const field = (name) =>
      article.querySelector(`[data-field="${name}"]`);

    field("heading").textContent = `Block #${formatInteger(block.height)}`;
    field("height").textContent = formatInteger(block.height);
    setTime(field("timestamp"), block.timestamp);

    const hashes = {
      hash: block.hash,
      "parent-hash": block.parentHash,
      "merkle-root": block.merkleRoot,
    };

    for (const [name, value] of Object.entries(hashes)) {
      field(name).textContent = value;

      const button = article.querySelector(
        `[data-copy-field="${name}"]`
      );

      button.disabled = false;
      button.addEventListener("click", () => copyText(value, button));
    }

    field("miner").textContent = block.miner;
    field("reward").textContent = formatAmount(block.rewardAtomic);
    field("transaction-count").textContent = formatInteger(
      block.transactionCount
    );

    field("transactions-status").textContent =
      block.transactions.length === 0
        ? "No transactions recorded in this block."
        : `${formatInteger(block.transactionCount)} recorded transactions.`;

    const transactions = field("transactions");

    for (const transaction of block.transactions) {
      transactions.append(renderTransaction(transaction));
    }

    return fragment;
  }

  async function fetchDetails(identifier) {
    return normalizeDetails(
      await request(`blocks/${encodeURIComponent(identifier)}`)
    );
  }

  function renderBlockRow(block) {
    const fragment = document.createDocumentFragment();
    const row = element("tr");

    cell(row, formatInteger(block.height), "block-height");

    const timestampCell = cell(row);
    const time = element("time");
    setTime(time, block.timestamp);
    timestampCell.append(time);

    cell(row, formatInteger(block.transactionCount), "numeric");
    cell(row, formatAmount(block.rewardAtomic), "numeric");

    const hashCell = cell(row);
    const shortHash = element(
      "code",
      `${block.hash.slice(0, 10)}…${block.hash.slice(-8)}`,
      "hash-preview"
    );

    shortHash.title = block.hash;
    hashCell.append(shortHash);

    const buttonCell = cell(row);
    const button = element(
      "button",
      "Details",
      "button-secondary details-toggle"
    );

    button.type = "button";
    button.setAttribute(
      "aria-label",
      `Details for block ${block.height}`
    );
    button.setAttribute("aria-expanded", "false");

    const detailsRow = element("tr", undefined, "block-details-row");
    const detailsCell = cell(detailsRow);
    detailsCell.colSpan = 6;
    detailsCell.id = `block-details-${block.height}-${block.hash}`;
    detailsRow.hidden = true;

    button.setAttribute("aria-controls", detailsCell.id);
    buttonCell.append(button);

    let loaded = false;
    let pending = false;

    button.addEventListener("click", async () => {
      if (pending) return;

      const opening = detailsRow.hidden;
      detailsRow.hidden = !opening;
      button.setAttribute("aria-expanded", String(opening));
      button.textContent = opening ? "Hide" : "Details";

      if (!opening || loaded) return;

      pending = true;
      button.disabled = true;
      detailsCell.setAttribute("aria-busy", "true");
      detailsCell.replaceChildren(
        element("p", "Loading block details…", "notice")
      );

      try {
        const details = await fetchDetails(block.hash);

        if (
          details.hash !== block.hash ||
          details.height !== block.height ||
          details.parentHash !== block.parentHash ||
          details.timestamp !== block.timestamp ||
          details.transactionCount !== block.transactionCount ||
          details.rewardAtomic !== block.rewardAtomic
        ) {
          throw new ExplorerError(
            "Block details do not match the displayed block. Refresh and try again."
          );
        }

        if (!detailsRow.isConnected) return;

        detailsCell.replaceChildren(renderDetails(details));
        loaded = true;
      } catch (error) {
        if (!detailsRow.isConnected) return;

        detailsCell.replaceChildren(
          element(
            "p",
            `${error.message} Close and reopen Details to retry.`,
            "notice notice-warning"
          )
        );
      } finally {
        pending = false;
        button.disabled = false;
        detailsCell.setAttribute("aria-busy", "false");
      }
    });

    fragment.append(row, detailsRow);
    return fragment;
  }

  function renderBlocks(blocks, append) {
    const fragment = document.createDocumentFragment();

    for (const block of blocks) {
      fragment.append(renderBlockRow(block));
    }

    if (append) {
      ui.body.append(fragment);
    } else {
      ui.body.replaceChildren(fragment);
    }
  }

  function clearSearch() {
    state.searchVersion += 1;
    state.searchController?.abort();
    state.searchController = null;
    state.searchBusy = false;

    ui.searchInput.value = "";
    ui.searchInput.removeAttribute("aria-invalid");
    ui.searchMessage.textContent = "";
    delete ui.searchMessage.dataset.state;

    ui.searchResult.hidden = true;
    ui.searchContent.replaceChildren();
    ui.clearSearch.hidden = true;
    updateControls();
  }

  async function loadBlocks(older = false) {
    if (state.listBusy) return;

    if (
      older &&
      (state.paginationNeedsRefresh ||
        state.nextBefore === null ||
        state.blocks.length >= CONFIG.maxDisplayedBlocks)
    ) {
      return;
    }

    state.listBusy = true;
    updateControls();

    if (!state.lastSuccess) setConnection("connecting");

    const parameters = { limit: CONFIG.pageSize };

    if (older) {
      parameters.before = state.nextBefore;
      parameters.tip_hash = state.tipHash;
    }

    try {
      const raw = await request("blocks", parameters);
      const page = normalizePage(raw, older);

      const previousTip = state.tipHash;
      const tipChanged =
        !older && previousTip !== null && previousTip !== page.tipHash;

      if (older) {
        state.blocks.push(...page.blocks);
        renderBlocks(page.blocks, true);
      } else {
        /*
         * Keep loaded rows and open details when the canonical tip
         * has not changed. Rebuild after a pagination conflict too,
         * even if the tip hash is unchanged, to restore a valid cursor.
         */
        if (
          previousTip !== page.tipHash ||
          state.blocks.length === 0 ||
          state.paginationNeedsRefresh
        ) {
          state.blocks = page.blocks;
          renderBlocks(page.blocks, false);
          state.nextBefore = page.nextBefore;
        }

        state.paginationNeedsRefresh = false;
        state.tipHash = page.tipHash;
        state.latestTimestamp = page.blocks[0].timestamp;

        ui.height.textContent = formatInteger(page.blocks[0].height);
        setTime(ui.time, state.latestTimestamp);

        if (tipChanged) {
          const hadSearch =
            !ui.searchResult.hidden || state.searchBusy;

          if (hadSearch) {
            clearSearch();
            ui.searchMessage.textContent =
              "The chain tip changed. Search again for a current result.";
          }
        }
      }

      if (older) state.nextBefore = page.nextBefore;

      state.lastSuccess = Date.now();
      ui.updated.textContent =
        `Last API update: ${displayTime(
          Math.floor(state.lastSuccess / 1000)
        )}`;

      setConnection("connected");
      clearNotice();
    } catch (error) {
      if (error?.name === "AbortError") return;

      if (older) {
        showNotice(error.message);

        if (error.status === 409) {
          state.paginationNeedsRefresh = true;
        }
      } else {
        setConnection(
          error.status === 0 &&
          /reach|timed out/i.test(error.message)
            ? "offline"
            : "error"
        );

        showNotice(
          state.blocks.length
            ? `${error.message} Previously loaded data remains visible and may be outdated.`
            : error.message,
          "error"
        );
      }
    } finally {
      state.listBusy = false;
      updateControls();
      scheduleRefresh();
    }
  }

  function scheduleRefresh() {
    window.clearTimeout(state.timer);

    const interval = Number(ui.interval.value);

    if (
      document.hidden ||
      interval === 0 ||
      ![30000, 60000, 600000].includes(interval)
    ) {
      return;
    }

    state.timer = window.setTimeout(() => {
      void loadBlocks();
    }, interval);
  }

  function parseSearch(value) {
    const query = value.trim();

    if (/^\d{1,20}$/.test(query)) {
      return unsigned(BigInt(query).toString(), "block height");
    }

    const withoutPrefix = query.replace(/^0x/i, "");

    if (/^[a-f0-9]{128}$/i.test(withoutPrefix)) {
      return withoutPrefix.toLowerCase();
    }

    throw new ExplorerError(
      "Enter a block height or a complete 128-character hexadecimal block hash."
    );
  }

  async function search(event) {
    event.preventDefault();

    let identifier;

    try {
      identifier = parseSearch(ui.searchInput.value);
    } catch (error) {
      ui.searchInput.setAttribute("aria-invalid", "true");
      ui.searchMessage.dataset.state = "error";
      ui.searchMessage.textContent = error.message;
      ui.searchResult.hidden = true;
      ui.searchContent.replaceChildren();
      ui.searchInput.focus();
      return;
    }

    state.searchController?.abort();
    const controller = new AbortController();
    state.searchController = controller;
    const version = ++state.searchVersion;

    state.searchBusy = true;
    ui.searchInput.removeAttribute("aria-invalid");
    delete ui.searchMessage.dataset.state;
    ui.searchMessage.textContent = "Searching…";
    ui.clearSearch.hidden = false;
    ui.searchResult.hidden = true;
    ui.searchContent.replaceChildren();
    updateControls();

    try {
      const raw = await request(
        `blocks/${encodeURIComponent(identifier)}`,
        {},
        controller.signal
      );

      const block = normalizeDetails(raw);

      if (
        (/^\d{1,20}$/.test(identifier) &&
          block.height !== identifier) ||
        (identifier.length === 128 && block.hash !== identifier)
      ) {
        throw new ExplorerError(
          "The API returned a different block from the one requested."
        );
      }

      if (version !== state.searchVersion) return;

      ui.searchContent.replaceChildren(renderDetails(block));
      ui.searchResult.hidden = false;
      ui.searchMessage.textContent =
        `Found block #${formatInteger(block.height)}. ` +
        "Canonical when retrieved.";

      const heading = $("search-result-heading");
      heading.tabIndex = -1;
      heading.focus();
    } catch (error) {
      if (
        version !== state.searchVersion ||
        error?.name === "AbortError"
      ) {
        return;
      }

      ui.searchMessage.dataset.state = "error";
      ui.searchMessage.textContent = error.message;
    } finally {
      if (version === state.searchVersion) {
        state.searchBusy = false;
        state.searchController = null;
        updateControls();
      }
    }
  }

  ui.searchForm.addEventListener("submit", (event) => {
    void search(event);
  });

  ui.clearSearch.addEventListener("click", () => {
    clearSearch();
    ui.searchInput.focus();
  });

  ui.searchInput.addEventListener("input", () => {
    ui.searchInput.removeAttribute("aria-invalid");
  });

  ui.refresh.addEventListener("click", () => {
    void loadBlocks();
  });

  ui.older.addEventListener("click", () => {
    void loadBlocks(true);
  });

  ui.interval.addEventListener("change", scheduleRefresh);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      window.clearTimeout(state.timer);
      return;
    }

    updateAge();

    if (Number(ui.interval.value) > 0) {
      void loadBlocks();
    }
  });

  window.addEventListener("pagehide", () => {
    window.clearTimeout(state.timer);

    for (const controller of state.controllers) {
      controller.abort();
    }
  });

  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      updateAge();

      if (Number(ui.interval.value) > 0) {
        void loadBlocks();
      }
    }
  });

  window.setInterval(() => {
    if (!document.hidden) updateAge();
  }, 1000);

  updateControls();
  void loadBlocks();
})();
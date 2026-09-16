(function attachInventoryRecountDomain(global) {
  const REMOVABLE_CODE_CHARACTERS = /[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]/gu;
  const REQUIRED_REDACTION_CANDIDATES = ["[redacted]", "[hidden]", "[private]", ""];
  const DETAIL_FIELDS = Object.freeze({
    sourceId: ["source_detail_row_id", "sourceDetailRowId", "rowId"],
    expectedSerial: ["expected_serial", "expectedSerial", "stock_serial", "stockSerial"],
    firstScannedCode: ["first_scanned_code", "firstScannedCode", "scanned_serial", "scannedSerial"],
    performer: ["first_counter_erp_name", "firstCounterErpName", "performed_by", "performedBy"],
    productName: ["product_name", "productName", "name"],
    stockBin: ["stock_bin", "stockBin", "bin"],
    firstCountBin: ["first_count_bin", "firstCountBin", "counted_bin", "countedBin", "bin"],
    status: ["first_count_status", "firstCountStatus", "status"],
    isNonSerial: ["is_non_serial", "isNonSerial"],
    resolution: ["recount_resolution", "recountResolution", "resolution"],
    resolved: ["is_resolved", "isResolved", "resolved"],
    excluded: ["excluded_from_actual", "excludedFromActual"]
  });

  function normalizeInventoryCode(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/[a-z]/g, character => String.fromCharCode(character.charCodeAt(0) - 32))
      .replace(REMOVABLE_CODE_CHARACTERS, "");
  }

  function maskCode(code, revealStart) {
    const characters = Array.from(code);
    const length = characters.length;
    if (length <= 4) return "*".repeat(length);

    const start = Math.max(0, Math.min(
      revealStart ?? length - 4,
      length - 4
    ));
    const width = Math.min(4, length - start);
    return "*".repeat(start)
      + characters.slice(start, start + width).join("")
      + "*".repeat(length - start - width);
  }

  function firstDifferingIndex(codes) {
    const characterGroups = codes.map(code => Array.from(code));
    const longest = Math.max(...characterGroups.map(characters => characters.length));
    for (let index = 0; index < longest; index += 1) {
      const character = characterGroups[0][index];
      if (characterGroups.some(characters => characters[index] !== character)) return index;
    }
    return null;
  }

  function serialSuffix(code) {
    return Array.from(code).slice(-4).join("");
  }

  function maskSerialGroup(serials) {
    const values = Array.isArray(serials) ? serials : [];
    const normalized = values.map(normalizeInventoryCode);
    const codesBySuffix = new Map();
    normalized.forEach(code => {
      const suffix = serialSuffix(code);
      if (!codesBySuffix.has(suffix)) codesBySuffix.set(suffix, []);
      codesBySuffix.get(suffix).push(code);
    });

    const differingIndices = new Map();
    for (const [suffix, codes] of codesBySuffix) {
      if (codes.length > 1) differingIndices.set(suffix, firstDifferingIndex(codes));
    }

    return new Map(values.map((value, index) => {
      const code = normalized[index];
      const differingIndex = differingIndices.get(serialSuffix(code));
      return [String(value ?? ""), maskCode(code, differingIndex ?? undefined)];
    }));
  }

  function firstDefined(row, fieldNames) {
    for (const fieldName of fieldNames) {
      if (row[fieldName] !== undefined && row[fieldName] !== null) return row[fieldName];
    }
    return undefined;
  }

  function detailField(row, fieldName) {
    return firstDefined(row, DETAIL_FIELDS[fieldName]);
  }

  function taskTypeForStatus(status) {
    const normalizedStatus = String(status ?? "").trim().toLocaleLowerCase("vi");
    if (normalizedStatus === "bắn thiếu (chưa quét)") return "missing_serial";
    if (normalizedStatus === "bắn sai serial") return "wrong_serial";
    if (normalizedStatus === "bắn dư serial" || normalizedStatus.startsWith("bắn dư (")) return "surplus_scan";
    return null;
  }

  function isResolvedDetailRow(source) {
    return Boolean(source.resolution || source.resolved || source.excludedFromActual);
  }

  function parseDetailRows(detailRows) {
    const rows = Array.isArray(detailRows) ? detailRows : [];
    const sourceIds = new Set();

    return rows.map((row, index) => {
      if (!row || typeof row !== "object") {
        throw new TypeError(`Invalid detail row at index ${index}`);
      }

      const rawSourceId = String(detailField(row, "sourceId") ?? "").trim();
      if (!rawSourceId) throw new Error(`Missing stable source detail row ID at index ${index}`);
      if (sourceIds.has(rawSourceId)) throw new Error(`Duplicate source detail row ID: ${rawSourceId}`);
      sourceIds.add(rawSourceId);

      const isNonSerial = Boolean(detailField(row, "isNonSerial"));
      const expectedSerial = normalizeInventoryCode(detailField(row, "expectedSerial"));
      const firstScannedCode = normalizeInventoryCode(detailField(row, "firstScannedCode"));
      if (!isNonSerial && !expectedSerial && !firstScannedCode) {
        throw new Error(`Missing expected or first-scanned inventory code at ${rawSourceId}`);
      }

      const status = String(detailField(row, "status") ?? "");
      const resolution = detailField(row, "resolution");
      const resolved = detailField(row, "resolved");
      const excludedFromActual = Boolean(detailField(row, "excluded"))
        || String(resolution ?? "") === "same_product_multiple_codes"
        || status === "Đã loại bỏ Serial dư";

      return {
        row,
        index,
        rawSourceId,
        publicSourceId: rawSourceId,
        isNonSerial,
        expectedSerial,
        firstScannedCode,
        performer: String(detailField(row, "performer") ?? ""),
        sku: String(row.sku ?? ""),
        productName: String(detailField(row, "productName") ?? ""),
        stockBin: String(detailField(row, "stockBin") ?? ""),
        firstCountBin: String(detailField(row, "firstCountBin") ?? ""),
        status,
        resolution,
        resolved,
        excludedFromActual,
        checked: Number(row.checked) || 0
      };
    });
  }

  function createProtectedCodeMatcher(protectedCodes) {
    const codes = [...new Set(protectedCodes.filter(Boolean))];
    const nodes = [{ transitions: new Map(), failure: 0, terminal: false }];

    for (const code of codes) {
      let state = 0;
      for (const character of code) {
        let nextState = nodes[state].transitions.get(character);
        if (nextState === undefined) {
          nextState = nodes.length;
          nodes[state].transitions.set(character, nextState);
          nodes.push({ transitions: new Map(), failure: 0, terminal: false });
        }
        state = nextState;
      }
      nodes[state].terminal = true;
    }

    const queue = [];
    for (const nextState of nodes[0].transitions.values()) queue.push(nextState);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const state = queue[cursor];
      for (const [character, nextState] of nodes[state].transitions) {
        queue.push(nextState);
        let fallback = nodes[state].failure;
        while (fallback && !nodes[fallback].transitions.has(character)) {
          fallback = nodes[fallback].failure;
        }
        const failureState = nodes[fallback].transitions.get(character);
        nodes[nextState].failure = failureState === undefined ? 0 : failureState;
        nodes[nextState].terminal = nodes[nextState].terminal || nodes[nodes[nextState].failure].terminal;
      }
    }

    function hasNormalizedMatch(normalizedValue) {
      let state = 0;
      for (const character of normalizedValue) {
        while (state && !nodes[state].transitions.has(character)) state = nodes[state].failure;
        const nextState = nodes[state].transitions.get(character);
        state = nextState === undefined ? 0 : nextState;
        if (nodes[state].terminal) return true;
      }
      return false;
    }

    return Object.freeze({
      hasMatch(value) {
        return hasNormalizedMatch(normalizeInventoryCode(value));
      }
    });
  }

  function hash32(value, seed) {
    let hash = seed >>> 0;
    for (const character of value) {
      const codePoint = character.codePointAt(0);
      hash ^= codePoint & 0xFFFF;
      hash = Math.imul(hash, 16777619);
      hash ^= codePoint >>> 16;
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function sourceIdDigest(sourceId) {
    return hash32(sourceId, 2166136261) + hash32(sourceId, 2246822507);
  }

  function assignSafeSourceIds(sources, matcher) {
    const safeIds = new Set(
      sources.filter(source => !matcher.hasMatch(source.rawSourceId)).map(source => source.rawSourceId)
    );
    const usedIds = new Set(safeIds);
    const replacements = new Map();
    const unsafeSourceIds = sources
      .filter(source => matcher.hasMatch(source.rawSourceId))
      .map(source => source.rawSourceId)
      .sort();

    for (const rawSourceId of unsafeSourceIds) {
      let replacement = null;
      for (let nonce = 0; nonce < 1000; nonce += 1) {
        const suffix = nonce === 0 ? "" : `-${nonce}`;
        const candidate = `row-${sourceIdDigest(`${rawSourceId}\u0000${nonce}`)}${suffix}`;
        if (!usedIds.has(candidate) && !matcher.hasMatch(candidate)) {
          replacement = candidate;
          break;
        }
      }
      if (!replacement) throw new Error(`Unable to derive a safe source identity for ${rawSourceId}`);
      replacements.set(rawSourceId, replacement);
      usedIds.add(replacement);
    }

    for (const source of sources) {
      source.publicSourceId = replacements.get(source.rawSourceId) ?? source.rawSourceId;
    }
  }

  function safeRequiredText(value, matcher, redactionText) {
    const text = String(value ?? "").trim();
    return matcher.hasMatch(text) ? redactionText : text;
  }

  function safeOptionalText(value, matcher) {
    const text = String(value ?? "").trim();
    if (!text || matcher.hasMatch(text)) return null;
    return text;
  }

  function safeRedactionText(matcher) {
    const candidate = REQUIRED_REDACTION_CANDIDATES.find(value => !matcher.hasMatch(value));
    if (candidate === undefined) throw new Error("Unable to construct safe redacted metadata");
    return candidate;
  }

  function profileAlias(profile) {
    return normalizeInventoryCode(
      profile?.erp_name_normalized
      ?? profile?.erpNameNormalized
      ?? profile?.erp_name
      ?? profile?.erpName
    );
  }

  function activeProfileAliases(profileRows) {
    const aliases = new Map();
    const activeProfiles = (Array.isArray(profileRows) ? profileRows : [])
      .filter(profile => profile?.status === "active")
      .slice()
      .sort((left, right) => String(left?.id ?? "").localeCompare(String(right?.id ?? "")));

    for (const profile of activeProfiles) {
      const alias = profileAlias(profile);
      if (!alias) continue;
      if (aliases.has(alias)) throw new Error(`Duplicate active ERP alias: ${alias}`);
      aliases.set(alias, profile);
    }
    return aliases;
  }

  function taskReference(source) {
    return source.expectedSerial || source.firstScannedCode;
  }

  function buildEvidenceForSource(source) {
    if (source.isNonSerial) return [];
    const evidenceByCode = new Map();
    const firstScannedMask = maskSerialGroup([source.firstScannedCode]).get(source.firstScannedCode);

    function addEvidence(serialNormalized, isCounted, bin) {
      if (!serialNormalized) return;
      const existing = evidenceByCode.get(serialNormalized);
      if (existing) {
        existing.is_counted = existing.is_counted || isCounted;
        if (isCounted && bin) existing.bin = bin;
        return;
      }
      evidenceByCode.set(serialNormalized, {
        source_detail_row_id: source.publicSourceId,
        sku: source.sku,
        serial_normalized: serialNormalized,
        expected_serial_normalized: source.expectedSerial,
        first_scanned_code_normalized: source.firstScannedCode,
        first_scanned_code_masked: firstScannedMask,
        bin: bin || null,
        is_counted: Boolean(isCounted),
        is_excluded: source.excludedFromActual
      });
    }

    const expectedWasCounted = source.checked > 0
      && (!source.firstScannedCode || source.firstScannedCode === source.expectedSerial);
    addEvidence(source.expectedSerial, expectedWasCounted, source.stockBin);
    addEvidence(source.firstScannedCode, source.checked > 0, source.firstCountBin);
    return [...evidenceByCode.values()];
  }

  function assertSafePublicTask(task, matcher, longCodeMatcher) {
    const protocolFields = new Set(["task_type", "state"]);
    for (const [field, value] of Object.entries(task)) {
      const fieldMatcher = protocolFields.has(field) ? longCodeMatcher : matcher;
      if (typeof value === "string" && fieldMatcher.hasMatch(value)) {
        throw new Error("Unable to construct a task without protected inventory code leakage");
      }
    }
  }

  function buildRecountDraft(detailRows, profileRows) {
    const sources = parseDetailRows(detailRows);
    const protectedCodes = sources
      .filter(source => !source.isNonSerial)
      .flatMap(source => [source.expectedSerial, source.firstScannedCode])
      .filter(Boolean);
    const matcher = createProtectedCodeMatcher(protectedCodes);
    const longCodeMatcher = createProtectedCodeMatcher(
      protectedCodes.filter(code => Array.from(code).length > 4)
    );
    assignSafeSourceIds(sources, matcher);
    const redactionText = safeRedactionText(matcher);
    const aliases = activeProfileAliases(profileRows);
    const taskSources = sources.filter(source => !source.isNonSerial
      && !isResolvedDetailRow(source)
      && taskTypeForStatus(source.status));

    const referencesBySku = new Map();
    for (const source of taskSources) {
      if (!referencesBySku.has(source.sku)) referencesBySku.set(source.sku, []);
      referencesBySku.get(source.sku).push(taskReference(source));
    }

    const masksBySku = new Map();
    for (const [sku, references] of referencesBySku) masksBySku.set(sku, maskSerialGroup(references));

    const tasks = taskSources.map(source => {
      const firstCounterAlias = normalizeInventoryCode(source.performer);
      const assignedProfile = aliases.get(firstCounterAlias) || null;
      const assignedUserId = safeOptionalText(assignedProfile?.id ?? assignedProfile?.user_id, matcher);
      const firstCounterName = safeOptionalText(assignedProfile?.full_name ?? assignedProfile?.fullName, matcher);
      const reference = taskReference(source);
      const task = {
        source_detail_row_id: source.publicSourceId,
        sku: safeRequiredText(source.sku, matcher, redactionText),
        product_name: safeRequiredText(source.productName, matcher, redactionText),
        stock_bin: safeOptionalText(source.stockBin, matcher),
        first_count_bin: safeOptionalText(source.firstCountBin, matcher),
        first_count_status: safeRequiredText(source.status, matcher, redactionText),
        first_counter_erp_name: safeOptionalText(source.performer, matcher),
        first_counter_name_snapshot: firstCounterName,
        assigned_user_id: assignedUserId,
        assigned_name_snapshot: firstCounterName,
        task_type: taskTypeForStatus(source.status),
        masked_reference: masksBySku.get(source.sku).get(reference),
        state: assignedUserId === null ? "unassigned" : "assigned"
      };
      assertSafePublicTask(task, matcher, longCodeMatcher);
      return task;
    });

    const evidence = sources.flatMap(buildEvidenceForSource);
    return { tasks, evidence };
  }

  function resolutionSourceDetailRowId(task) {
    return String(task?.source_detail_row_id ?? task?.sourceDetailRowId ?? task?.rowId ?? "").trim();
  }

  function isConfirmedResolution(task) {
    if (!task?.resolution) return false;
    if (task.confirmed === false || task.is_confirmed === false) return false;
    if (task.confirmed !== true && task.is_confirmed !== true) return false;

    const suppliedStates = [task.state, task.status].filter(value => value !== undefined && value !== null);
    if (suppliedStates.some(value => value !== "completed")) return false;

    if (task.resolution === "genuine_surplus") {
      return task.managerApproved === true || task.manager_approved === true;
    }
    return true;
  }

  function applyConfirmedRecounts(detailRows, resolvedTasks) {
    const sources = parseDetailRows(detailRows);
    const matcher = createProtectedCodeMatcher(
      sources
        .filter(source => !source.isNonSerial)
        .flatMap(source => [source.expectedSerial, source.firstScannedCode])
        .filter(Boolean)
    );
    assignSafeSourceIds(sources, matcher);

    const confirmedBySource = new Map();
    for (const task of (Array.isArray(resolvedTasks) ? resolvedTasks : [])) {
      if (!isConfirmedResolution(task)) continue;
      const sourceId = resolutionSourceDetailRowId(task);
      if (sourceId) confirmedBySource.set(sourceId, task);
    }

    return sources.map(source => {
      const row = source.row;
      const task = confirmedBySource.get(source.publicSourceId);
      if (!task) return row;

      const resolution = task.resolution;
      if (resolution === "same_product_multiple_codes") {
        return {
          ...row,
          checked: 0,
          diff: 0,
          status: "Đã loại bỏ Serial dư",
          excludedFromActual: true,
          recountResolution: resolution
        };
      }
      if (resolution === "corrected_serial") {
        const correctedSerial = task.correctedSerial ?? task.corrected_serial ?? task.scannedSerial ?? task.scanned_serial;
        const wasCountedInRoundOne = Number(row?.checked) > 0;
        return {
          ...row,
          ...(correctedSerial === undefined ? {} : { scannedSerial: correctedSerial }),
          ...(wasCountedInRoundOne ? {} : { l2Added: true }),
          checked: 1,
          diff: 0,
          status: "Đã quét đủ",
          recountResolution: resolution
        };
      }
      if (resolution === "not_found") {
        return {
          ...row,
          recountResolution: resolution,
          ...(task.reason === undefined ? {} : { recountReason: task.reason })
        };
      }
      if (resolution === "genuine_surplus") {
        const scannedSerial = task.scannedSerial ?? task.scanned_serial ?? task.correctedSerial ?? task.corrected_serial;
        return {
          ...row,
          ...(scannedSerial === undefined ? {} : { scannedSerial }),
          checked: 1,
          diff: 1,
          status: "Bắn dư serial",
          recountResolution: resolution
        };
      }
      return row;
    });
  }

  const api = Object.freeze({
    normalizeInventoryCode,
    maskSerialGroup,
    buildRecountDraft,
    applyConfirmedRecounts
  });
  global.InventoryRecountDomain = api;
})(typeof window !== "undefined" ? window : globalThis);

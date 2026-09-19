(function attachInventoryRecountDomain(global) {
  const REMOVABLE_CODE_CHARACTERS = /[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]/gu;
  const REQUIRED_REDACTION_CANDIDATES = ["[redacted]", "[hidden]", "[private]", ""];
  const NOT_FOUND_STATUS = "Bắn thiếu (Chưa quét)";
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

  function projectInventoryCode(value) {
    return String(value ?? "")
      .replace(/[a-z]/g, character => String.fromCharCode(character.charCodeAt(0) - 32))
      .replace(REMOVABLE_CODE_CHARACTERS, "");
  }

  function normalizeInventoryCode(value) {
    return projectInventoryCode(String(value ?? "").normalize("NFKC"));
  }

  function projectCompatibilityCodePoints(value) {
    const text = String(value ?? "");
    if (/^[\x00-\x7F]*$/u.test(text)) return projectInventoryCode(text);
    const normalizedCodePoints = [];
    for (const character of text) {
      normalizedCodePoints.push(character.normalize("NFKC"));
    }
    return projectInventoryCode(normalizedCodePoints.join(""));
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

  function suppliedAliasEntries(row, fieldNames) {
    return fieldNames
      .filter(fieldName => Object.prototype.hasOwnProperty.call(row, fieldName)
        && row[fieldName] !== undefined
        && row[fieldName] !== null)
      .map(fieldName => ({ fieldName, value: row[fieldName] }));
  }

  function consistentTextAlias(row, fieldNames, label, location, normalizer, options = {}) {
    const entries = suppliedAliasEntries(row, fieldNames);
    const normalizedEntries = entries.map(entry => ({
      ...entry,
      normalized: normalizer(entry.value)
    }));
    const meaningful = options.allowEmpty
      ? normalizedEntries
      : normalizedEntries.filter(entry => entry.normalized !== "");
    const distinct = new Set(meaningful.map(entry => entry.normalized));
    if (distinct.size > 1) throw new Error(`Conflicting ${label} aliases at ${location}`);
    const selected = meaningful[0];
    return {
      value: selected?.value,
      normalized: selected?.normalized ?? "",
      rawValues: meaningful.map(entry => String(entry.value ?? ""))
    };
  }

  function consistentBooleanAlias(row, fieldNames, label, location) {
    const entries = suppliedAliasEntries(row, fieldNames);
    const distinct = new Set(entries.map(entry => entry.value));
    if (distinct.size > 1) throw new Error(`Conflicting ${label} aliases at ${location}`);
    return entries.length ? entries[0].value : undefined;
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

      const sourceIdEntries = suppliedAliasEntries(row, DETAIL_FIELDS.sourceId);
      if (sourceIdEntries.some(entry => String(entry.value).trim() === "")) {
        throw new Error(`Missing stable source detail row ID at index ${index}`);
      }
      const sourceIdAlias = consistentTextAlias(
        row,
        DETAIL_FIELDS.sourceId,
        "source detail row ID",
        `index ${index}`,
        value => String(value ?? "").trim()
      );
      const rawSourceId = sourceIdAlias.normalized;
      if (!rawSourceId) throw new Error(`Missing stable source detail row ID at index ${index}`);
      if (sourceIds.has(rawSourceId)) throw new Error(`Duplicate source detail row ID: ${rawSourceId}`);
      sourceIds.add(rawSourceId);

      const isNonSerial = Boolean(detailField(row, "isNonSerial"));
      const expectedAlias = consistentTextAlias(
        row,
        DETAIL_FIELDS.expectedSerial,
        "expected serial",
        rawSourceId,
        normalizeInventoryCode
      );
      const scannedAlias = consistentTextAlias(
        row,
        DETAIL_FIELDS.firstScannedCode,
        "first-scanned code",
        rawSourceId,
        normalizeInventoryCode
      );
      const performerAlias = consistentTextAlias(
        row,
        DETAIL_FIELDS.performer,
        "performer",
        rawSourceId,
        normalizeInventoryCode
      );
      const expectedSerial = expectedAlias.normalized;
      const firstScannedCode = scannedAlias.normalized;
      const statusAlias = consistentTextAlias(
        row,
        DETAIL_FIELDS.status,
        "first-count status",
        rawSourceId,
        value => String(value ?? "").trim()
      );
      const resolutionAlias = consistentTextAlias(
        row,
        DETAIL_FIELDS.resolution,
        "recount resolution",
        rawSourceId,
        value => String(value ?? "").trim()
      );
      const status = statusAlias.normalized;
      const resolution = resolutionAlias.normalized || undefined;
      const resolved = detailField(row, "resolved");
      const excludedAlias = consistentBooleanAlias(
        row,
        DETAIL_FIELDS.excluded,
        "exclusion",
        rawSourceId
      );
      const codeLessResolved = Boolean(resolved)
        || Boolean(excludedAlias)
        || status === "Đã loại bỏ Serial dư"
        || resolution === "same_product_multiple_codes";
      if (!isNonSerial && !expectedSerial && !firstScannedCode && !codeLessResolved) {
        throw new Error(`Missing expected or first-scanned inventory code at ${rawSourceId}`);
      }
      const excludedFromActual = Boolean(excludedAlias)
        || String(resolution ?? "") === "same_product_multiple_codes"
        || status === "Đã loại bỏ Serial dư";

      return {
        row,
        index,
        rawSourceId,
        publicSourceId: rawSourceId,
        isNonSerial,
        expectedSerial,
        expectedSerialVariants: expectedAlias.rawValues,
        firstScannedCode,
        firstScannedCodeVariants: scannedAlias.rawValues,
        performer: String(performerAlias.value ?? ""),
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
    const codes = [...new Set(protectedCodes
      .flatMap(code => [
        projectInventoryCode(code),
        projectCompatibilityCodePoints(code),
        normalizeInventoryCode(code)
      ])
      .filter(Boolean))];
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
        const rawProjection = projectInventoryCode(value);
        if (hasNormalizedMatch(rawProjection)) return true;
        const compatibilityProjection = projectCompatibilityCodePoints(value);
        if (compatibilityProjection !== rawProjection
          && hasNormalizedMatch(compatibilityProjection)) return true;
        const normalizedProjection = normalizeInventoryCode(value);
        return normalizedProjection !== rawProjection
          && normalizedProjection !== compatibilityProjection
          && hasNormalizedMatch(normalizedProjection);
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
    return consistentTextAlias(
      profile ?? {},
      ["erp_name_normalized", "erpNameNormalized", "erp_name", "erpName"],
      "profile ERP name",
      String(profile?.id ?? "unknown profile"),
      normalizeInventoryCode
    ).normalized;
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
      .flatMap(source => [
        ...source.expectedSerialVariants,
        ...source.firstScannedCodeVariants
      ])
      .filter(Boolean);
    const matcher = createProtectedCodeMatcher(protectedCodes);
    const longCodeMatcher = createProtectedCodeMatcher(
      protectedCodes.filter(code => Array.from(normalizeInventoryCode(code)).length > 4)
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
      const proposedMask = masksBySku.get(source.sku).get(reference);
      const safeMask = matcher.hasMatch(proposedMask)
        ? "*".repeat(Array.from(reference).length)
        : proposedMask;
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
        masked_reference: safeMask,
        state: assignedUserId === null ? "unassigned" : "assigned"
      };
      assertSafePublicTask(task, matcher, longCodeMatcher);
      return task;
    });

    const evidence = sources.flatMap(buildEvidenceForSource);
    return { tasks, evidence };
  }

  function resolutionSourceDetailRowId(task, index) {
    const sourceIdEntries = suppliedAliasEntries(task ?? {}, DETAIL_FIELDS.sourceId);
    if (sourceIdEntries.some(entry => String(entry.value).trim() === "")) {
      throw new Error(`Missing source detail row ID for recount resolution at index ${index}`);
    }
    const sourceId = consistentTextAlias(
      task ?? {},
      DETAIL_FIELDS.sourceId,
      "source detail row ID",
      `recount resolution index ${index}`,
      value => String(value ?? "").trim()
    ).normalized;
    if (!sourceId) throw new Error(`Missing source detail row ID for recount resolution at index ${index}`);
    return sourceId;
  }

  function resolutionBooleanAlias(task, fieldNames, label, sourceId) {
    const entries = suppliedAliasEntries(task ?? {}, fieldNames);
    const distinct = new Set(entries.map(entry => entry.value));
    if (distinct.size > 1) throw new Error(`Conflicting ${label} aliases for source ${sourceId}`);
    return entries.length ? entries[0].value : undefined;
  }

  function resolutionValue(task, sourceId) {
    return consistentTextAlias(
      task ?? {},
      ["resolution", "recount_resolution", "recountResolution"],
      "recount resolution",
      `source ${sourceId}`,
      value => String(value ?? "").trim()
    ).normalized;
  }

  function isConfirmedResolution(task, sourceId, resolution) {
    if (!resolution) return false;
    const confirmed = resolutionBooleanAlias(
      task,
      ["confirmed", "is_confirmed"],
      "confirmation",
      sourceId
    );
    if (confirmed !== true) return false;

    const suppliedStates = [task.state, task.status].filter(value => value !== undefined && value !== null);
    if (suppliedStates.some(value => value !== "completed")) return false;

    if (resolution === "genuine_surplus") {
      return resolutionBooleanAlias(
        task,
        ["managerApproved", "manager_approved"],
        "manager approval",
        sourceId
      ) === true;
    }
    return true;
  }

  function synchronizedAliasPatch(row, fieldNames, canonicalField, value) {
    const patch = { [canonicalField]: value };
    for (const fieldName of fieldNames) {
      if (Object.prototype.hasOwnProperty.call(row, fieldName)) patch[fieldName] = value;
    }
    return patch;
  }

  function applyConfirmedRecounts(detailRows, resolvedTasks) {
    const sources = parseDetailRows(detailRows);
    const matcher = createProtectedCodeMatcher(
      sources
        .filter(source => !source.isNonSerial)
        .flatMap(source => [
          ...source.expectedSerialVariants,
          ...source.firstScannedCodeVariants
        ])
        .filter(Boolean)
    );
    assignSafeSourceIds(sources, matcher);

    const confirmedBySource = new Map();
    const resolutionRows = Array.isArray(resolvedTasks) ? resolvedTasks : [];
    const seenResolutionSources = new Set();
    for (let index = 0; index < resolutionRows.length; index += 1) {
      const task = resolutionRows[index];
      const sourceId = resolutionSourceDetailRowId(task, index);
      if (seenResolutionSources.has(sourceId)) {
        throw new Error(`Duplicate recount resolution for source ${sourceId}`);
      }
      seenResolutionSources.add(sourceId);
      const resolution = resolutionValue(task, sourceId);
      if (!isConfirmedResolution(task, sourceId, resolution)) continue;
      confirmedBySource.set(sourceId, { ...task, resolution });
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
          ...synchronizedAliasPatch(row, DETAIL_FIELDS.status, "status", "Đã loại bỏ Serial dư"),
          ...synchronizedAliasPatch(row, DETAIL_FIELDS.excluded, "excludedFromActual", true),
          ...synchronizedAliasPatch(row, DETAIL_FIELDS.resolution, "recountResolution", resolution)
        };
      }
      if (resolution === "corrected_serial") {
        const correctedAlias = consistentTextAlias(
          task,
          ["correctedSerial", "corrected_serial", "scannedSerial", "scanned_serial"],
          "corrected serial",
          `source ${source.publicSourceId}`,
          normalizeInventoryCode
        );
        const correctedSerial = correctedAlias.value;
        const wasCountedInRoundOne = Number(row?.checked) > 0;
        return {
          ...row,
          ...(correctedSerial === undefined
            ? {}
            : synchronizedAliasPatch(row, DETAIL_FIELDS.firstScannedCode, "scannedSerial", correctedSerial)),
          ...(wasCountedInRoundOne ? {} : { l2Added: true }),
          checked: 1,
          diff: 0,
          ...synchronizedAliasPatch(row, DETAIL_FIELDS.status, "status", "Đã quét đủ"),
          ...synchronizedAliasPatch(row, DETAIL_FIELDS.excluded, "excludedFromActual", false),
          ...synchronizedAliasPatch(row, DETAIL_FIELDS.resolution, "recountResolution", resolution)
        };
      }
      if (resolution === "not_found") {
        return {
          ...row,
          ...synchronizedAliasPatch(row, DETAIL_FIELDS.status, "status", NOT_FOUND_STATUS),
          ...synchronizedAliasPatch(row, DETAIL_FIELDS.excluded, "excludedFromActual", false),
          ...synchronizedAliasPatch(row, DETAIL_FIELDS.resolution, "recountResolution", resolution),
          ...(task.reason === undefined ? {} : { recountReason: task.reason })
        };
      }
      if (resolution === "genuine_surplus") {
        const scannedAlias = consistentTextAlias(
          task,
          ["scannedSerial", "scanned_serial", "correctedSerial", "corrected_serial"],
          "scanned serial",
          `source ${source.publicSourceId}`,
          normalizeInventoryCode
        );
        const scannedSerial = scannedAlias.value;
        return {
          ...row,
          ...(scannedSerial === undefined
            ? {}
            : synchronizedAliasPatch(row, DETAIL_FIELDS.firstScannedCode, "scannedSerial", scannedSerial)),
          checked: 1,
          diff: 1,
          ...synchronizedAliasPatch(row, DETAIL_FIELDS.status, "status", "Bắn dư serial"),
          ...synchronizedAliasPatch(row, DETAIL_FIELDS.excluded, "excludedFromActual", false),
          ...synchronizedAliasPatch(row, DETAIL_FIELDS.resolution, "recountResolution", resolution)
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

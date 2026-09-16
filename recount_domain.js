(function attachInventoryRecountDomain(global) {
  const INVISIBLE_CODE_CHARACTERS = /[\s\u200B\u200C\u200D\u2060\uFEFF]/gu;

  function normalizeInventoryCode(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .toUpperCase()
      .replace(INVISIBLE_CODE_CHARACTERS, "");
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

  function taskTypeForStatus(status) {
    const normalizedStatus = String(status ?? "").trim().toLocaleLowerCase("vi");
    if (normalizedStatus === "bắn thiếu (chưa quét)") return "missing_serial";
    if (normalizedStatus === "bắn sai serial") return "wrong_serial";
    if (normalizedStatus === "bắn dư serial" || normalizedStatus.startsWith("bắn dư (")) return "surplus_scan";
    return null;
  }

  function isResolvedDetailRow(row) {
    return Boolean(
      row?.recountResolution
      ?? row?.recount_resolution
      ?? row?.resolution
      ?? row?.resolved
      ?? row?.isResolved
      ?? row?.excludedFromActual
    );
  }

  function sourceDetailRowId(row, index) {
    return String(
      row?.source_detail_row_id
      ?? row?.sourceDetailRowId
      ?? row?.rowId
      ?? `${String(row?.sku ?? "")}::${index}`
    );
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
      if (aliases.has(alias)) {
        throw new Error(`Duplicate active ERP alias: ${alias}`);
      }
      aliases.set(alias, profile);
    }
    return aliases;
  }

  function taskReference(expectedSerial, firstScannedCode) {
    return expectedSerial || firstScannedCode;
  }

  function exposesProtectedCode(value, protectedCodes) {
    const candidate = normalizeInventoryCode(value);
    if (!candidate) return false;

    return protectedCodes.some(code => {
      if (!code) return false;
      if (candidate.includes(code)) return true;
      if (candidate.length > 4 && code.includes(candidate)) return true;
      for (let index = 0; index <= code.length - 5; index += 1) {
        if (candidate.includes(code.slice(index, index + 5))) return true;
      }
      return false;
    });
  }

  function safeSnapshot(value, protectedCodes) {
    const snapshot = String(value ?? "").trim();
    if (!snapshot || exposesProtectedCode(snapshot, protectedCodes)) return null;
    return snapshot;
  }

  function buildRecountDraft(detailRows, profileRows) {
    const aliases = activeProfileAliases(profileRows);
    const sources = (Array.isArray(detailRows) ? detailRows : [])
      .map((row, index) => {
        if (row?.isNonSerial || row?.is_non_serial || isResolvedDetailRow(row)) return null;
        const taskType = taskTypeForStatus(row?.status);
        if (!taskType) return null;

        const expectedSerial = normalizeInventoryCode(row?.stockSerial);
        const firstScannedCode = normalizeInventoryCode(row?.scannedSerial);
        const firstCounterAlias = normalizeInventoryCode(row?.performedBy);
        const assignedProfile = aliases.get(firstCounterAlias) || null;
        const assignedUserId = String(assignedProfile?.id ?? assignedProfile?.user_id ?? "") || null;
        const protectedCodes = [expectedSerial, firstScannedCode].filter(Boolean);
        const firstCounterErpName = safeSnapshot(row?.performedBy, protectedCodes);
        const firstCounterName = safeSnapshot(assignedProfile?.full_name ?? assignedProfile?.fullName, protectedCodes);
        return {
          source_detail_row_id: sourceDetailRowId(row, index),
          sku: String(row?.sku ?? ""),
          product_name: String(row?.product_name ?? row?.productName ?? row?.name ?? ""),
          stock_bin: String(row?.stock_bin ?? row?.stockBin ?? row?.bin ?? ""),
          first_count_bin: String(row?.first_count_bin ?? row?.firstCountBin ?? row?.bin ?? ""),
          first_count_status: String(row?.status ?? ""),
          first_counter_erp_name: firstCounterErpName,
          first_counter_name_snapshot: firstCounterName,
          assigned_user_id: assignedUserId,
          assigned_name_snapshot: firstCounterName,
          task_type: taskType,
          expectedSerial,
          firstScannedCode
        };
      })
      .filter(Boolean);

    const masksBySku = new Map();
    for (const source of sources) {
      if (!masksBySku.has(source.sku)) masksBySku.set(source.sku, []);
      masksBySku.get(source.sku).push(taskReference(source.expectedSerial, source.firstScannedCode));
    }

    const taskMasks = new Map();
    for (const [sku, references] of masksBySku) {
      taskMasks.set(sku, maskSerialGroup(references));
    }

    const tasks = sources.map(source => {
      const reference = taskReference(source.expectedSerial, source.firstScannedCode);
      const assigned = source.assigned_user_id !== null;
      return {
        source_detail_row_id: source.source_detail_row_id,
        sku: source.sku,
        product_name: source.product_name,
        stock_bin: source.stock_bin || null,
        first_count_bin: source.first_count_bin || null,
        first_count_status: source.first_count_status,
        first_counter_erp_name: source.first_counter_erp_name || null,
        first_counter_name_snapshot: source.first_counter_name_snapshot || null,
        assigned_user_id: source.assigned_user_id,
        assigned_name_snapshot: source.assigned_name_snapshot,
        task_type: source.task_type,
        masked_reference: taskMasks.get(source.sku).get(reference),
        state: assigned ? "assigned" : "unassigned"
      };
    });

    const evidence = sources.map(source => {
      const firstMask = maskSerialGroup([source.firstScannedCode]).get(source.firstScannedCode);
      return {
        source_detail_row_id: source.source_detail_row_id,
        sku: source.sku,
        serial_normalized: source.firstScannedCode || source.expectedSerial,
        expected_serial_normalized: source.expectedSerial,
        first_scanned_code_normalized: source.firstScannedCode,
        first_scanned_code_masked: firstMask,
        bin: source.first_count_bin || null,
        is_counted: source.task_type !== "missing_serial",
        is_excluded: false
      };
    });

    return { tasks, evidence };
  }

  function resolutionSourceDetailRowId(task) {
    return String(task?.source_detail_row_id ?? task?.sourceDetailRowId ?? task?.rowId ?? "");
  }

  function isConfirmedResolution(task) {
    if (!task?.resolution || task.confirmed === false || task.is_confirmed === false) return false;
    if (task.resolution === "genuine_surplus") {
      if (task.managerApproved === false || task.manager_approved === false) return false;
      return task.managerApproved === true
        || task.manager_approved === true
        || Boolean(task.completed_at)
        || task.state === "completed"
        || task.status === "completed";
    }
    if (task.confirmed === true || task.is_confirmed === true || task.completed_at) return true;
    if (task.state !== undefined || task.status !== undefined) {
      return task.state === "completed" || task.status === "completed";
    }
    return true;
  }

  function applyConfirmedRecounts(detailRows, resolvedTasks) {
    const confirmedBySource = new Map();
    for (const task of (Array.isArray(resolvedTasks) ? resolvedTasks : [])) {
      if (!isConfirmedResolution(task)) continue;
      const sourceId = resolutionSourceDetailRowId(task);
      if (sourceId) confirmedBySource.set(sourceId, task);
    }

    return (Array.isArray(detailRows) ? detailRows : []).map((row, index) => {
      const task = confirmedBySource.get(sourceDetailRowId(row, index));
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

import { useEffect, useState } from 'react';
import { AuditPreviewModal } from './components/AuditPreviewModal';
import { SidebarNav } from './components/SidebarNav';
import { TopHeader } from './components/TopHeader';
import { VoiceCommandDock } from './components/VoiceCommandDock';
import { INITIAL_OPS_STATE, ROLE_PROFILES } from './data/initialData';
import {
  AuditLogEntry,
  OpsState,
  ProductionStage,
  RoleId,
  SalesOrder,
  SalesStage,
  ScreenId,
} from './types/ops';
import { parseAndExecuteCommand } from './utils/commandParser';
import { exportComplianceCsv } from './utils/exportAudit';
import { ComplianceAuditView } from './views/ComplianceAuditView';
import { OperationsHubView } from './views/OperationsHubView';
import { ProductionBomView } from './views/ProductionBomView';
import { SalesOrdersView } from './views/SalesOrdersView';
import { StockLedgerView } from './views/StockLedgerView';

const STORAGE_KEY = 'batchline_ops_state_v1';

function loadInitialState(): OpsState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as OpsState;
      if (parsed && Array.isArray(parsed.batches) && Array.isArray(parsed.lots)) {
        return parsed;
      }
    }
  } catch {
    // ignore storage read errors
  }
  return INITIAL_OPS_STATE;
}

export default function App() {
  const [state, setState] = useState<OpsState>(loadInitialState);
  const [selectedBatchId, setSelectedBatchId] = useState<string>(
    () => loadInitialState().batches[0]?.id ?? 'batch-402'
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore storage quota errors
    }
  }, [state]);

  const activeOperator =
    ROLE_PROFILES.find((r) => r.id === state.activeRole) || ROLE_PROFILES[0];

  const appendAudit = (
    prev: OpsState,
    action: string,
    detail: string,
    refCode: string,
    status: 'verified' | 'flagged' = 'verified',
    source: AuditLogEntry['source'] = 'manual'
  ): AuditLogEntry => ({
    id: `aud-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    timestamp: new Date().toTimeString().slice(0, 8),
    actor: activeOperator.operatorName,
    roleLabel: activeOperator.label,
    source,
    action,
    detail,
    refCode,
    status,
  });

  const handleSelectRole = (role: RoleId) => {
    setState((prev) => ({ ...prev, activeRole: role }));
  };

  const handleSelectScreen = (screen: ScreenId) => {
    setState((prev) => ({ ...prev, activeScreen: screen }));
  };

  const handleResetDemo = () => {
    setState(INITIAL_OPS_STATE);
    setSelectedBatchId(INITIAL_OPS_STATE.batches[0].id);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  const handleVoiceCommand = (command: string) => {
    const result = parseAndExecuteCommand(command, state);
    setState(result.nextState);
    return { summary: result.summary, status: result.status };
  };

  const handleAdvanceBatchStage = (batchId: string) => {
    const order: ProductionStage[] = [
      'mixing',
      'baking',
      'packaging',
      'completed',
    ];
    setState((prev) => {
      const target = prev.batches.find((b) => b.id === batchId);
      if (!target) return prev;
      const idx = order.indexOf(target.stage);
      const nextStage = order[Math.min(order.length - 1, idx + 1)];
      if (nextStage === target.stage) return prev;

      const audit = appendAudit(
        prev,
        'Batch Stage Advanced',
        `Batch ${target.batchCode} (${target.productName}) moved from ${target.stage} to ${nextStage}`,
        target.batchCode
      );
      return {
        ...prev,
        batches: prev.batches.map((b) =>
          b.id === batchId ? { ...b, stage: nextStage } : b
        ),
        auditLogs: [audit, ...prev.auditLogs],
      };
    });
  };

  const handleToggleChecklistItem = (batchId: string, checkId: string) => {
    setState((prev) => {
      const batch = prev.batches.find((b) => b.id === batchId);
      const chk = batch?.checklist.find((c) => c.id === checkId);
      if (!batch || !chk) return prev;

      const nextChecked = !chk.checked;
      const now = new Date().toTimeString().slice(0, 5);
      const audit = appendAudit(
        prev,
        nextChecked ? 'CCP Check Signed' : 'CCP Check Unchecked',
        `${chk.label} on Batch ${batch.batchCode}`,
        batch.batchCode
      );

      return {
        ...prev,
        batches: prev.batches.map((b) =>
          b.id !== batchId
            ? b
            : {
                ...b,
                checklist: b.checklist.map((c) =>
                  c.id !== checkId
                    ? c
                    : {
                        ...c,
                        checked: nextChecked,
                        verifiedBy: nextChecked
                          ? activeOperator.operatorName
                          : undefined,
                        timestamp: nextChecked ? now : undefined,
                      }
                ),
              }
        ),
        auditLogs: [audit, ...prev.auditLogs],
      };
    });
  };

  const handleUpdateYield = (batchId: string, actualKg: number) => {
    setState((prev) => {
      const batch = prev.batches.find((b) => b.id === batchId);
      if (!batch) return prev;
      const deltaPct =
        ((actualKg - batch.targetYieldKg) / batch.targetYieldKg) * 100;
      const flagged = Math.abs(deltaPct) > 1.5;

      const audit = appendAudit(
        prev,
        'Scale Yield Updated',
        `Batch ${batch.batchCode} scale weight updated to ${actualKg.toFixed(1)}kg (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}% vs target)`,
        batch.batchCode,
        flagged ? 'flagged' : 'verified'
      );

      return {
        ...prev,
        batches: prev.batches.map((b) =>
          b.id === batchId ? { ...b, actualYieldKg: actualKg } : b
        ),
        auditLogs: [audit, ...prev.auditLogs],
      };
    });
  };

  const handleAdjustTemp = (batchId: string, deltaC: number) => {
    setState((prev) => ({
      ...prev,
      batches: prev.batches.map((b) =>
        b.id === batchId ? { ...b, ovenTempC: b.ovenTempC + deltaC } : b
      ),
    }));
  };

  const handleDoseIngredient = (
    batchId: string,
    ingredientId: string,
    addKg: number
  ) => {
    setState((prev) => {
      const batch = prev.batches.find((b) => b.id === batchId);
      const ing = batch?.ingredients.find((i) => i.id === ingredientId);
      if (!batch || !ing) return prev;

      const audit = appendAudit(
        prev,
        'BOM Ingredient Dosed',
        `Added +${addKg.toFixed(1)}kg ${ing.materialName} (${ing.lotNumber}) to Batch ${batch.batchCode}`,
        batch.batchCode
      );

      return {
        ...prev,
        batches: prev.batches.map((b) =>
          b.id !== batchId
            ? b
            : {
                ...b,
                ingredients: b.ingredients.map((i) =>
                  i.id === ingredientId
                    ? {
                        ...i,
                        actualKg: Number((i.actualKg + addKg).toFixed(1)),
                        verified: true,
                      }
                    : i
                ),
              }
        ),
        lots: prev.lots.map((l) => {
          if (l.lotNumber !== ing.lotNumber) return l;
          const nextQty = Math.max(0, Number((l.quantityKg - addKg).toFixed(1)));
          return {
            ...l,
            quantityKg: nextQty,
            health:
              l.health === 'lot_hold'
                ? 'lot_hold'
                : nextQty < l.parLevelKg
                  ? 'low_stock'
                  : 'healthy',
          };
        }),
        auditLogs: [audit, ...prev.auditLogs],
      };
    });
  };

  const handleCreateBatch = (
    productName: string,
    skuCode: string,
    targetYieldKg: number,
    zone: string
  ) => {
    setState((prev) => {
      const nextNum = 405 + prev.batches.length;
      const batchCode = `#${nextNum}`;
      const newId = `batch-${nextNum}`;
      const newBatch = {
        id: newId,
        batchCode,
        skuCode,
        productName,
        stage: 'mixing' as const,
        zone,
        targetYieldKg,
        actualYieldKg: targetYieldKg,
        ovenTempC: 165,
        targetTempC: 165,
        startedAt: new Date().toTimeString().slice(0, 5),
        assignedLead: activeOperator.operatorName,
        ingredients: [
          {
            id: `ing-${nextNum}-1`,
            materialName: 'Organic Rolled Oats',
            lotNumber: 'LOT-408B',
            targetKg: Number((targetYieldKg * 0.55).toFixed(1)),
            actualKg: Number((targetYieldKg * 0.55).toFixed(1)),
            verified: true,
          },
        ],
        checklist: [
          {
            id: `chk-${nextNum}-1`,
            label: 'Dry hopper sanitation & allergen swab',
            checked: false,
          },
          {
            id: `chk-${nextNum}-2`,
            label: 'Inline metal detector 1.5mm Fe test',
            checked: false,
          },
        ],
      };
      const audit = appendAudit(
        prev,
        'Started New Production Batch',
        `Launched Batch ${batchCode} for ${productName} (Target ${targetYieldKg}kg)`,
        batchCode
      );
      setSelectedBatchId(newId);
      return {
        ...prev,
        batches: [newBatch, ...prev.batches],
        auditLogs: [audit, ...prev.auditLogs],
      };
    });
  };

  const handleToggleLotHold = (lotId: string, customReason?: string) => {
    setState((prev) => {
      const lot = prev.lots.find((l) => l.id === lotId);
      if (!lot) return prev;
      const releasing = lot.health === 'lot_hold';
      const nextHealth = releasing
        ? lot.quantityKg < lot.parLevelKg
          ? ('low_stock' as const)
          : ('healthy' as const)
        : ('lot_hold' as const);
      const reason = releasing
        ? undefined
        : customReason || 'QA sensory / moisture variance hold';

      const audit = appendAudit(
        prev,
        releasing ? 'QA Lot Hold Released' : 'QA Lot Hold Placed',
        releasing
          ? `${lot.lotNumber} (${lot.materialName}) cleared back to active inventory`
          : `${lot.lotNumber} (${lot.materialName}) quarantined: ${reason}`,
        lot.lotNumber,
        releasing ? 'verified' : 'flagged'
      );

      return {
        ...prev,
        lots: prev.lots.map((l) =>
          l.id === lotId ? { ...l, health: nextHealth, holdReason: reason } : l
        ),
        auditLogs: [audit, ...prev.auditLogs],
      };
    });
  };

  const handleReceiveStock = (lotId: string, addKg: number) => {
    setState((prev) => {
      const lot = prev.lots.find((l) => l.id === lotId);
      if (!lot) return prev;
      const nextQty = Number((lot.quantityKg + addKg).toFixed(1));
      const nextHealth =
        lot.health === 'lot_hold'
          ? 'lot_hold'
          : nextQty >= lot.parLevelKg
            ? ('healthy' as const)
            : ('low_stock' as const);

      const audit = appendAudit(
        prev,
        'Raw Material Received',
        `Added +${addKg}kg to ${lot.lotNumber} (${lot.materialName})`,
        lot.lotNumber
      );

      return {
        ...prev,
        lots: prev.lots.map((l) =>
          l.id === lotId
            ? { ...l, quantityKg: nextQty, health: nextHealth }
            : l
        ),
        auditLogs: [audit, ...prev.auditLogs],
      };
    });
  };

  const handleAddLot = (
    materialName: string,
    skuCode: string,
    lotNumber: string,
    supplier: string,
    quantityKg: number,
    moisturePct: number
  ) => {
    setState((prev) => {
      const newLot = {
        id: `lot-${Date.now()}`,
        skuCode,
        materialName,
        lotNumber,
        supplier,
        quantityKg,
        parLevelKg: 50,
        moisturePct,
        health: quantityKg < 50 ? ('low_stock' as const) : ('healthy' as const),
        receivedDate: new Date().toISOString().slice(0, 10),
        allergenClass: 'Verified COA',
      };
      const audit = appendAudit(
        prev,
        'New Raw Lot Logged',
        `Received ${quantityKg}kg ${materialName} (${lotNumber}) from ${supplier}`,
        lotNumber
      );
      return {
        ...prev,
        lots: [newLot, ...prev.lots],
        auditLogs: [audit, ...prev.auditLogs],
      };
    });
  };

  const handleAssignBatchToOrder = (orderId: string, batchCode: string) => {
    setState((prev) => {
      const order = prev.orders.find((o) => o.id === orderId);
      if (!order) return prev;
      const nextStage: SalesStage = batchCode ? 'allocated' : 'ingested';
      const audit = appendAudit(
        prev,
        batchCode ? 'Batch Linked to Order' : 'Batch Unlinked',
        batchCode
          ? `Linked Batch ${batchCode} to ${order.orderCode} (${order.customerName})`
          : `Cleared batch link from ${order.orderCode}`,
        order.orderCode
      );
      return {
        ...prev,
        orders: prev.orders.map((o) =>
          o.id === orderId
            ? {
                ...o,
                assignedBatchCode: batchCode || null,
                unitsAllocated: batchCode ? o.unitsOrdered : 0,
                stage: o.stage === 'ingested' || !batchCode ? nextStage : o.stage,
              }
            : o
        ),
        auditLogs: [audit, ...prev.auditLogs],
      };
    });
  };

  const handleAdvanceOrderStage = (orderId: string) => {
    const seq: SalesStage[] = ['ingested', 'allocated', 'packed', 'dispatched'];
    setState((prev) => {
      const order = prev.orders.find((o) => o.id === orderId);
      if (!order) return prev;
      const idx = seq.indexOf(order.stage);
      const nextStage = seq[Math.min(seq.length - 1, idx + 1)];
      if (nextStage === order.stage) return prev;

      const audit = appendAudit(
        prev,
        'Sales Order Stage Updated',
        `${order.orderCode} (${order.customerName}) moved to ${nextStage}`,
        order.orderCode
      );
      return {
        ...prev,
        orders: prev.orders.map((o) =>
          o.id === orderId
            ? {
                ...o,
                stage: nextStage,
                unitsAllocated: o.unitsOrdered,
                assignedBatchCode:
                  o.assignedBatchCode || prev.batches[0]?.batchCode || '#402',
              }
            : o
        ),
        auditLogs: [audit, ...prev.auditLogs],
      };
    });
  };

  const handleCreateOrder = (
    customerName: string,
    channel: SalesOrder['channel'],
    productName: string,
    unitsOrdered: number,
    dueDate: string
  ) => {
    setState((prev) => {
      const nextNum = 1089 + prev.orders.length;
      const orderCode = `#SO-${nextNum}`;
      const newOrder: SalesOrder = {
        id: `so-${nextNum}`,
        orderCode,
        customerName,
        channel,
        skuCode: productName.includes('Chickpea')
          ? 'FG-CHP-204'
          : productName.includes('Cherry')
            ? 'FG-CHR-308'
            : 'FG-OAT-101',
        productName,
        unitsOrdered,
        unitsAllocated: 0,
        assignedBatchCode: null,
        stage: 'ingested',
        dueDate,
      };
      const audit = appendAudit(
        prev,
        'Sales Order Ingested',
        `Created ${orderCode} for ${customerName} (${unitsOrdered} units ${productName})`,
        orderCode
      );
      return {
        ...prev,
        orders: [newOrder, ...prev.orders],
        auditLogs: [audit, ...prev.auditLogs],
      };
    });
  };

  const handleResolveAuditFlag = (logId: string) => {
    setState((prev) => ({
      ...prev,
      auditLogs: prev.auditLogs.map((l) =>
        l.id === logId ? { ...l, status: 'verified' } : l
      ),
    }));
  };

  const alertCount = state.lots.filter((l) => l.health !== 'healthy').length;

  return (
    <div className="min-h-screen flex bg-[#F8FAFC] text-[#0F172A]">
      <SidebarNav
        activeScreen={state.activeScreen}
        activeRole={state.activeRole}
        onSelectScreen={handleSelectScreen}
        onResetDemo={handleResetDemo}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
        alertCount={alertCount}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopHeader
          activeScreen={state.activeScreen}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onExportCsv={() => exportComplianceCsv(state)}
          onOpenPdfPreview={() => setPdfModalOpen(true)}
        />

        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 pb-28 max-w-[1440px] w-full mx-auto">
          {state.activeScreen === 'operations' && (
            <OperationsHubView
              state={state}
              onSelectRole={handleSelectRole}
              onNavigate={handleSelectScreen}
              onSelectBatchForBom={(batchId) => {
                setSelectedBatchId(batchId);
                handleSelectScreen('production');
              }}
              onAdvanceBatchStage={handleAdvanceBatchStage}
              onToggleChecklistItem={handleToggleChecklistItem}
              onToggleLotHold={(lotId) => handleToggleLotHold(lotId)}
              onAdvanceOrderStage={handleAdvanceOrderStage}
            />
          )}

          {state.activeScreen === 'production' && (
            <ProductionBomView
              batches={state.batches}
              selectedBatchId={selectedBatchId}
              onSelectBatch={setSelectedBatchId}
              onUpdateYield={handleUpdateYield}
              onAdjustTemp={handleAdjustTemp}
              onDoseIngredient={handleDoseIngredient}
              onToggleCheck={handleToggleChecklistItem}
              onAdvanceStage={handleAdvanceBatchStage}
              onCreateBatch={handleCreateBatch}
            />
          )}

          {state.activeScreen === 'inventory' && (
            <StockLedgerView
              lots={state.lots}
              batches={state.batches}
              onToggleHold={handleToggleLotHold}
              onReceiveStock={handleReceiveStock}
              onAddLot={handleAddLot}
            />
          )}

          {state.activeScreen === 'orders' && (
            <SalesOrdersView
              orders={state.orders}
              batches={state.batches}
              onAssignBatch={handleAssignBatchToOrder}
              onAdvanceOrder={handleAdvanceOrderStage}
              onCreateOrder={handleCreateOrder}
            />
          )}

          {state.activeScreen === 'compliance' && (
            <ComplianceAuditView
              auditLogs={state.auditLogs}
              onResolveFlag={handleResolveAuditFlag}
              onExportCsv={() => exportComplianceCsv(state)}
              onOpenPdfPreview={() => setPdfModalOpen(true)}
            />
          )}
        </main>
      </div>

      <VoiceCommandDock onExecuteCommand={handleVoiceCommand} />

      <AuditPreviewModal
        open={pdfModalOpen}
        onClose={() => setPdfModalOpen(false)}
        state={state}
      />
    </div>
  );
}

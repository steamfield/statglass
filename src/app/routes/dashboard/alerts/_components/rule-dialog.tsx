/**
 * The rule editor: a dialog over one custom rule's form (`_lib/rule-form`),
 * saved as one settings patch.
 */
import type {
  AlertRule,
  SettingsSnapshot,
  UnitSettings,
} from "@core/generated/types";
import { settingsErrorText } from "@core/settings-patch";
import type { CommandResult } from "@core/transport";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { InlineMessage } from "~/components/inline-message";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "~/components/ui/dialog";
import { useSettings, useUpdateSettings } from "~/stores/settings-store";
import {
  formFromRule,
  formProblem,
  type RuleForm,
  ruleFromForm,
  rulesWithSaved,
  withChange,
} from "../_lib/rule-form";
import { ConditionPanel, NotificationPanel } from "./rule-fields";

/** The rule the dialog edits, and whether Save appends it or replaces it. */
export interface RuleDraft {
  rule: AlertRule;
  isNew: boolean;
}

/** Props of `RuleDialog`. */
export interface RuleDialogProps {
  /** The rule to edit; null keeps the dialog closed. */
  draft: RuleDraft | null;
  /** Close without anything further: after Save, Delete, Cancel or Escape. */
  onClose: () => void;
}

const NO_RULES: AlertRule[] = [];

/**
 * The "New rule" / "Edit rule" dialog. Fields labelled "Name", "Metric",
 * "Watch" (only for a labelled metric: "Any", then series names), "When it
 * is" (above, below), "Threshold" with its display unit, "For" and "Then
 * wait"; a "Now" line with the watched series' current value, the only part
 * that renders on a live tick; `formProblem` text inline with Save
 * disabled. Save sends `{ alerts: { rules } }` with the rule appended (new)
 * or replaced (edit) through `updateSettings` and closes; a rejected save
 * shows its message inline and keeps the form. Delete (existing rules only)
 * removes the rule and closes. Cancel and Escape write nothing.
 */
export function RuleDialog({ draft, onClose }: RuleDialogProps): ReactNode {
  const units = useSettings((s) => s.units);
  if (draft === null || units === null) return null;
  // A units change rebuilds the form from the rule, so the typed threshold
  // is never read in a unit it was not typed in.
  return (
    <RuleEditor
      key={`${draft.rule.id} ${JSON.stringify(units)}`}
      draft={draft}
      units={units}
      onClose={onClose}
    />
  );
}

/** The form a draft opens with; a new rule is named after its sentence. */
function initialForm(draft: RuleDraft, units: UnitSettings): RuleForm {
  const form = formFromRule(draft.rule, units);
  return draft.isNew
    ? withChange({ ...form, autoName: true }, {}, units)
    : form;
}

/**
 * Writes the rules list once. Closes on success and keeps the reason on
 * failure; once the dialog has closed, a late answer changes nothing here.
 */
function useRulesWrite(onClose: () => void) {
  const update = useUpdateSettings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const write = async (rules: AlertRule[]) => {
    setSaving(true);
    setError(null);
    const failure = await writeFailure(() => update({ alerts: { rules } }));
    if (!open.current) return;
    setSaving(false);
    if (failure === null) onClose();
    else setError(failure);
  };
  return { saving, error, write, clearError: () => setError(null) };
}

/** Runs one settings write; the failure as inline text, or null when saved. */
async function writeFailure(
  run: () => Promise<CommandResult<SettingsSnapshot>>
): Promise<string | null> {
  try {
    const result = await run();
    if (result.status === "ok") return null;
    console.error("[alerts] update_settings rejected", result.error);
    return settingsErrorText(result.error);
  } catch (err) {
    console.error("[alerts] update_settings failed", err);
    return settingsErrorText(err);
  }
}

/** The open dialog for one draft, holding its form until it closes. */
function RuleEditor({
  draft,
  units,
  onClose,
}: {
  draft: RuleDraft;
  units: UnitSettings;
  onClose: () => void;
}) {
  const rules = useSettings((s) => s.alerts?.rules ?? NO_RULES) ?? NO_RULES;
  const [form, setForm] = useState(() => initialForm(draft, units));
  const { saving, error, write, clearError } = useRulesWrite(onClose);
  const problem = formProblem(form, units);
  const edit = (next: RuleForm) => {
    setForm(next);
    clearError();
  };
  const save = () =>
    void write(rulesWithSaved(rules, ruleFromForm(form, units)));
  const remove = () => void write(rules.filter((r) => r.id !== form.id));
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[calc(100svh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]"
      >
        <header className="border-border-subtle border-b px-5 py-4 pr-12">
          <DialogTitle>{draft.isNew ? "New rule" : "Edit rule"}</DialogTitle>
        </header>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
          <fieldset disabled={saving} className="flex min-w-0 flex-col gap-5">
            <ConditionPanel form={form} units={units} onChange={edit} />
            <NotificationPanel form={form} onChange={edit} />
          </fieldset>
          {(problem ?? error) && (
            <InlineMessage tone="error">{problem ?? error}</InlineMessage>
          )}
        </div>
        <footer className="flex shrink-0 gap-2 border-border-subtle border-t px-5 py-3">
          {!draft.isNew && (
            <Button variant="outline" disabled={saving} onClick={remove}>
              Delete
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || problem !== null} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

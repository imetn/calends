import { parsers } from 'prettier/plugins/typescript';
import { readFileSync } from 'node:fs';

// Existing component harnesses compile each original view and its extracted parts together.
const groups: Record<string, string[]> = {
  'app/src/components/ScopeReport.tsx': ['app/src/components/ScopeReport.tsx', 'app/src/components/ScopeLifecycleReport.tsx'],
  'app/src/views/Detail.tsx': [
    'app/src/views/detail/shared.tsx',
    'app/src/views/detail/Kpis.tsx',
    'app/src/views/Detail.tsx',
    'app/src/views/detail/Ledgers.tsx',
    'app/src/views/detail/ChargeTimeline.tsx',
    'app/src/views/detail/Events.tsx',
    'app/src/views/detail/Notices.tsx',
    'app/src/views/detail/Periods.tsx',
    'app/src/views/detail/Summary.tsx',
  ],
  'app/src/views/Carpool.tsx': [
    'app/src/views/carpool/common.ts',
    'app/src/views/Carpool.tsx',
    'app/src/views/carpool/CarTable.tsx',
    'app/src/views/carpool/Members.tsx',
    'app/src/views/detail/Periods.tsx',
    'app/src/views/carpool/CarSheet.tsx',
    'app/src/views/carpool/ConvertSheet.tsx',
  ],
  'app/src/views/Members.tsx': [
    'app/src/views/member/useMemberForm.ts',
    'app/src/views/member/Receipts.tsx',
    'app/src/views/member-fields.tsx',
    'app/src/views/Members.tsx',
    'app/src/views/MemberForm.tsx',
    'app/src/views/MemberReceipt.tsx',
    'app/src/views/member-status.ts',
  ],
  'app/src/views/List.tsx': ['app/src/components/FacetRow.tsx', 'app/src/views/List.tsx'],
  'app/src/views/People.tsx': ['app/src/views/People.tsx', 'app/src/views/person-fields.tsx', 'app/src/views/PersonProfile.tsx'],
  'app/src/views/Proxy.tsx': ['app/src/views/proxy/common.tsx', 'app/src/views/Proxy.tsx', 'app/src/views/proxy/sheets.tsx'],
  'app/src/views/Editor.tsx': [
    'app/src/views/editor/linked.ts',
    'app/src/views/editor/LinkedSubSheet.tsx',
    'app/src/views/editor/useEditorDraft.ts',
    'app/src/views/editor/save.ts',
    'app/src/views/editor/useEditorFields.ts',
    'app/src/views/editor/icon-upload.tsx',
    'app/src/views/editor/Sections.tsx',
    'app/src/views/editor/Form.tsx',
    'app/src/views/editor/new-sub.ts',
    'app/src/views/editor/draft.ts',
    'app/src/views/Editor.tsx',
    'app/src/views/editor/NameField.tsx',
  ],
  'app/src/views/Assistant.tsx': [
    'app/src/views/assistant-chat.ts',
    'app/src/views/Assistant.tsx',
    'app/src/views/AssistantProposal.tsx',
    'app/src/views/AssistantSetup.tsx',
    'app/src/views/AssistantWidgets.tsx',
  ],
  'app/src/components/ui.tsx': [
    'app/src/components/icons.tsx',
    'app/src/components/marks.tsx',
    'app/src/components/inputs.tsx',
    'app/src/components/ui.tsx',
    'app/src/components/overlays.tsx',
  ],
};

export function readUiSource(url: URL): string {
  const key = Object.keys(groups).find((key) => new URL('../' + key, import.meta.url).href === url.href);
  return key ? groups[key].map((part) => readFileSync(new URL('../' + part, import.meta.url), 'utf8')).join('\n') : readFileSync(url, 'utf8');
}

export function extractUiFunction(url: URL, name: string): string {
  const source = readUiSource(url);
  const ast = parsers.typescript.parse(source);
  const node = ast.body.find((n: any) => (n.declaration ?? n).type === 'FunctionDeclaration' && (n.declaration ?? n).id?.name === name);
  if (!node) throw new Error(`Missing component ${name} in ${url}`);
  return source.slice(...(node.declaration ?? node).range);
}

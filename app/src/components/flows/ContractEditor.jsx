import { useState } from 'react'
import clsx from 'clsx'
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react'
import { Kicker } from '../editorial/atoms'

const KIND_OPTIONS = [
  { value: 'judgment', label: 'Judgment' },
  { value: 'check', label: 'Check' },
]
const SEV_OPTIONS = [
  { value: 'blocker', label: 'Blocker' },
  { value: 'warning', label: 'Warning' },
]

function RuleForm({ initial, onSave, onCancel }) {
  const [rule, setRule] = useState(initial?.rule ?? '')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [kind, setKind] = useState(initial?.kind ?? 'judgment')
  const [severity, setSeverity] = useState(initial?.severity ?? 'blocker')

  function submit(e) {
    e.preventDefault()
    if (!rule.trim()) return
    onSave({ ...initial, rule: rule.trim(), label: label.trim() || rule.trim().slice(0, 40), kind, severity })
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-accent/40 bg-surf-2 px-3 py-3 flex flex-col gap-2.5">
      <textarea
        autoFocus
        value={rule}
        onChange={e => setRule(e.target.value)}
        placeholder="Rule text…"
        rows={2}
        className="w-full text-[12.5px] text-ink bg-paper border border-line rounded-md px-2.5 py-2 outline-none focus:border-ink transition-colors resize-none placeholder:text-mute-2"
      />
      <input
        value={label}
        onChange={e => setLabel(e.target.value)}
        placeholder="Short label (optional)"
        className="w-full text-[12px] text-ink bg-paper border border-line rounded-md px-2.5 py-1.5 outline-none focus:border-ink transition-colors placeholder:text-mute-2"
      />
      <div className="flex gap-2">
        <div className="flex gap-1">
          {KIND_OPTIONS.map(o => (
            <button key={o.value} type="button" onClick={() => setKind(o.value)}
              className={clsx('px-2.5 py-1 rounded border text-[11px] transition-colors', kind === o.value ? 'border-ink bg-ink text-paper' : 'border-line text-mute hover:bg-paper')}>
              {o.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 ml-2">
          {SEV_OPTIONS.map(o => (
            <button key={o.value} type="button" onClick={() => setSeverity(o.value)}
              className={clsx('px-2.5 py-1 rounded border text-[11px] transition-colors', severity === o.value ? 'border-ink bg-ink text-paper' : 'border-line text-mute hover:bg-paper')}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="p-1.5 rounded text-mute hover:text-ink transition-colors"><X size={14} /></button>
        <button type="submit" disabled={!rule.trim()} className="p-1.5 rounded text-[#4ade80] hover:text-ink transition-colors disabled:opacity-30"><Check size={14} /></button>
      </div>
    </form>
  )
}

function RuleRow({ rule, onEdit, onDelete }) {
  const warn = rule.severity === 'warning'
  return (
    <div className="group flex items-start gap-2 py-0.5">
      <span className={clsx(
        'font-mono text-[8.5px] font-bold tracking-[0.06em] px-1 rounded mt-[3px] shrink-0',
        warn ? 'text-mute border border-dashed border-mute-2' : 'bg-ink-2 text-paper',
      )}>
        {warn ? 'WARN' : 'BLOCK'}
      </span>
      <span className="flex-1 text-[11.5px] text-ink-2 leading-snug">
        {rule.rule}
        <span className="text-mute-2 font-mono text-[9px] ml-1.5">{rule.kind === 'check' ? 'check' : 'judgment'}</span>
      </span>
      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button onClick={() => onEdit(rule)} className="p-1 rounded text-mute hover:text-ink transition-colors"><Pencil size={11} /></button>
        <button onClick={() => onDelete(rule)} className="p-1 rounded text-mute hover:text-[#C0432D] transition-colors"><Trash2 size={11} /></button>
      </div>
    </div>
  )
}

export default function ContractEditor({ title, rules, onChange }) {
  const [editingIdx, setEditingIdx] = useState(null)
  const [adding, setAdding] = useState(false)

  function handleSave(rule, idx) {
    if (idx == null) {
      onChange([...rules, rule])
    } else {
      onChange(rules.map((r, i) => i === idx ? rule : r))
    }
    setEditingIdx(null)
    setAdding(false)
  }

  function handleDelete(rule) {
    onChange(rules.filter(r => r !== rule))
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <Kicker>{title}</Kicker>
      </div>
      <div className="flex flex-col gap-1.5">
        {rules.map((rule, i) => (
          editingIdx === i
            ? <RuleForm key={i} initial={rule} onSave={r => handleSave(r, i)} onCancel={() => setEditingIdx(null)} />
            : <RuleRow key={i} rule={rule} onEdit={() => setEditingIdx(i)} onDelete={() => handleDelete(rule)} />
        ))}
        {adding && (
          <RuleForm onSave={r => handleSave(r, null)} onCancel={() => setAdding(false)} />
        )}
        {!adding && editingIdx == null && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-[11px] text-mute hover:text-ink transition-colors mt-0.5 self-start"
          >
            <Plus size={12} />
            Add rule
          </button>
        )}
      </div>
    </div>
  )
}

import { IDEA_FIELDS } from '../lib/workshop'
import type { IdeaDraft } from '../lib/workshop'

export function IdeaFields({ value, onChange, disabled, idPrefix }: {
  value: IdeaDraft; onChange: (value: IdeaDraft) => void; disabled: boolean; idPrefix: string;
}) {
  return <div className="idea-fields">{IDEA_FIELDS.map(({ key, label, placeholder }) =>
    <div className="idea-field" key={key}>
      <label htmlFor={`${idPrefix}-${key}`}>{label}<span className="field-optional" aria-hidden="true">{key === 'task' ? 'Obligatoria' : 'Opcional'}</span></label>
      <textarea id={`${idPrefix}-${key}`} value={value[key]} placeholder={placeholder} aria-label={label}
        onChange={event => onChange({ ...value, [key]: event.target.value })}
        maxLength={500} required={key === 'task'} disabled={disabled} rows={3}
        aria-describedby={`${idPrefix}-${key}-count`} />
      <small id={`${idPrefix}-${key}-count`}>{value[key].length}/500</small>
    </div>
  )}</div>
}

export function IdeaContent({ idea }: { idea: IdeaDraft }) {
  return <dl className="idea-details">{IDEA_FIELDS.filter(({ key }) => key === 'task' || idea[key].trim()).map(({ key, label }) =>
    <div key={key}><dt>{label}</dt><dd className={`${key === 'task' ? 'note-content' : ''} ${!idea[key] ? 'field-empty' : ''}`}>
      {idea[key] || 'Sin completar'}
    </dd></div>
  )}</dl>
}

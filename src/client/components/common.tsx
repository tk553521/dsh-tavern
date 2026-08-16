/**
 * Small shared presentation components for the tavern view. Pure props only.
 */
import type { ReactNode } from 'react'
import css from '../TavernView.module.css'

export function Button(props: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  title?: string
}) {
  const cls = props.variant === 'primary'
    ? `${css.btn} ${css.btnPrimary}`
    : props.variant === 'danger'
      ? `${css.btn} ${css.btnDanger}`
      : props.variant === 'ghost'
        ? `${css.btn} ${css.btnGhost}`
        : css.btn
  return (
    <button
      type="button"
      className={cls}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
  )
}

export function Field(props: {
  label: string
  children: ReactNode
}) {
  return (
    <label className={css.field}>
      <span className={css.fieldLabel}>{props.label}</span>
      {props.children}
    </label>
  )
}

export function TextInput(props: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <input
      className={css.fieldInput}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={event => props.onChange(event.target.value)}
    />
  )
}

export function TextArea(props: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
  disabled?: boolean
}) {
  return (
    <textarea
      className={css.fieldTextarea}
      value={props.value}
      placeholder={props.placeholder}
      rows={props.rows}
      disabled={props.disabled}
      onChange={event => props.onChange(event.target.value)}
    />
  )
}

export function Select(props: {
  value: string | undefined
  onChange: (value: string | undefined) => void
  options: { value: string; label: string }[]
  placeholder?: string
}) {
  return (
    <select
      className={css.fieldSelect}
      value={props.value ?? ''}
      onChange={event => {
        const value = event.target.value
        props.onChange(value === '' ? undefined : value)
      }}
    >
      <option value="">{props.placeholder ?? '（无）'}</option>
      {props.options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  )
}

export function Checkbox(props: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  return (
    <label className={css.checkRow}>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={event => props.onChange(event.target.checked)}
      />
      {props.label}
    </label>
  )
}

export function Spinner() {
  return <span className={css.spinner} aria-label="加载中" />
}

export function Empty(props: { text: string }) {
  return <div className={css.empty}>{props.text}</div>
}

/** Simple confirm dialog via window.confirm. */
export function confirmAction(message: string): boolean {
  return window.confirm(message)
}

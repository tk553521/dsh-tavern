/**
 * Prompt assembly for tavern generation: character cards, world-book output,
 * and presets become the system prompts of the director and character
 * agents.
 */

import type { CharacterRecord, Play, Preset } from './types.ts'

/**
 * Make imported SillyTavern / roleplay text safe for DSH prompt rendering.
 * DSH treats every complete `{{name}}` group as a strict prompt-variable
 * reference; ST cards often contain literal macros like `{{user}}` / `{{char}}`.
 * Since DSH has no escape syntax for literal braces, collapse the double
 * braces to single braces (`{user}`) so the card stays readable and the
 * prompt renderer never sees an unknown variable.
 */
export function stripPromptVariables(text: string): string {
  let out = text
  while (out.includes('{{') || out.includes('}}')) {
    out = out.split('{{').join('{').split('}}').join('}')
  }
  return out
}

/** Character card sections joined into the role description. */
export function characterProfile(character: CharacterRecord): string {
  const data = character.card.data
  const sections: string[] = []
  const description = stripPromptVariables(data.description.trim())
  const personality = stripPromptVariables(data.personality.trim())
  const scenario = stripPromptVariables(data.scenario.trim())
  if (description !== '') sections.push(`角色设定：\n${description}`)
  if (personality !== '') sections.push(`性格：\n${personality}`)
  if (scenario !== '') sections.push(`当前场景：\n${scenario}`)
  return sections.join('\n\n')
}

/** System prompt for one character agent (multi-agent mode). */
export function buildCharacterSystem(
  character: CharacterRecord,
  loreText: string,
  preset: Preset | undefined,
  extras: string[],
): string {
  const data = character.card.data
  const name = stripPromptVariables(data.name)
  const safeLoreText = stripPromptVariables(loreText)
  const safeExtras = extras.map(stripPromptVariables)
  const parts: string[] = []
  parts.push('你正在参与一场角色扮演（roleplay），你是其中的一个角色。')
  parts.push(`你扮演的角色名字是：${name}`)
  const profile = characterProfile(character)
  if (profile !== '') parts.push(profile)
  if (safeLoreText !== '') parts.push(safeLoreText)
  if (safeExtras.length > 0) parts.push(safeExtras.join('\n'))
  const presetSystem = stripPromptVariables(preset?.systemPrompt ?? '').trim()
  const cardSystem = stripPromptVariables(data.system_prompt).trim()
  if (presetSystem !== '') parts.push(presetSystem)
  else if (cardSystem !== '') parts.push(cardSystem)
  parts.push([
    '扮演规则：',
    `- 你只扮演 ${name}，只输出 ${name} 的台词、动作与内心活动；不要替其他角色发言。`,
    '- 台词直接输出，动作与神态描写用 *斜体* 或括号括起。',
    '- 不要输出关于你自己的解释、不要提及"角色扮演"或"AI"等字眼，除非角色设定要求。',
    '- 保持角色的一致性，回应要自然、有代入感。',
  ].join('\n'))
  const postHistory = stripPromptVariables(data.post_history_instructions).trim()
  if (postHistory !== '') {
    parts.push(`扮演补充规则：\n${postHistory}`)
  }
  return parts.join('\n\n')
}

/** Classic single-agent system prompt (narrator plays everyone). */
export function buildClassicSystem(
  play: Play,
  characters: readonly CharacterRecord[],
  loreText: string,
  preset: Preset | undefined,
): string {
  const parts: string[] = []
  parts.push('你正在主持并参与一场角色扮演。你同时扮演以下所有角色与叙述者：')
  for (const id of play.characterIds) {
    const character = characters.find(c => c.id === id)
    if (character === undefined) continue
    const data = character.card.data
    parts.push(`【角色 ${stripPromptVariables(data.name)}】`)
    const profile = characterProfile(character)
    if (profile !== '') parts.push(profile)
    const cardSystem = stripPromptVariables(data.system_prompt).trim()
    if (cardSystem !== '') parts.push(cardSystem)
  }
  const safeLoreText = stripPromptVariables(loreText)
  if (safeLoreText !== '') parts.push(safeLoreText)
  const presetSystem = stripPromptVariables(preset?.systemPrompt ?? '').trim()
  if (presetSystem !== '') parts.push(presetSystem)
  parts.push([
    '扮演规则：',
    '- 每个角色发言时以「角色名：」开头，叙述与场景描写直接输出。',
    '- 台词直接输出，动作与神态描写用 *斜体* 或括号括起。',
    '- 保持各角色设定一致，回应自然、有代入感，避免冗长。',
  ].join('\n'))
  return parts.join('\n\n')
}

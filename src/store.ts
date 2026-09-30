import { useCallback, useEffect, useRef, useState } from 'react'
import { sampleScript } from './sample'
import type { Character, ContinuityState, DiffItem, Prop, Reply, Scene, Script, Version, Wardrobe, WarningItem, WarningReview } from './types'

const STORAGE_KEY = 'sologsb-1017-continuity-v1'
const clone = <T,>(value: T): T => structuredClone(value)
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/** 按当前故事次序（scenes 数组）补全拍摄次序，已有顺序尽量保留。 */
export function normalizeShootOrder(scenes: Scene[], shootOrder: string[] | undefined): string[] {
  const existing = Array.isArray(shootOrder) ? shootOrder : []
  const seen = new Set<string>()
  const preserved = existing.filter((sceneId) => {
    if (seen.has(sceneId)) return false
    seen.add(sceneId)
    return scenes.some((scene) => scene.id === sceneId)
  })
  // 旧数据升级（shootOrder 缺失）时，这里会按当前故事次序回填。
  const appended = scenes.map((scene) => scene.id).filter((sceneId) => !seen.has(sceneId))
  return [...preserved, ...appended]
}

/** 旧版本快照/旧本地稿升级：补齐拍摄次序等新增字段，不改动场次身份与故事顺序。 */
function upgradeScript(script: Script): Script {
  return { ...script, shootOrder: normalizeShootOrder(script.scenes, script.shootOrder) }
}

function initialState(): ContinuityState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ContinuityState
      if (parsed.script?.scenes?.length) {
        return {
          ...parsed,
          script: upgradeScript(parsed.script),
          // 未确认批次不在升级范围内，一律回到已确认的拍摄次序。
          scheduleDraft: null
        }
      }
    }
  } catch {
    // Ignore an invalid local draft and restore the bundled example.
  }
  return { script: clone(sampleScript), scheduleDraft: null, reviews: {}, versions: [], updatedAt: new Date().toISOString() }
}

/** 故事顺序中的场景序列（连续检查、大纲、时间线一律以此为准）。 */
export function storyOrderedScenes(script: Script): Scene[] {
  return script.scenes
}

/** 拍摄次序中的场景序列（剧组排期视图使用）。 */
export function shootOrderedScenes(script: Script, order: string[] = script.shootOrder): Scene[] {
  const byId = new Map(script.scenes.map((scene) => [scene.id, scene]))
  return order.map((sceneId) => byId.get(sceneId)).filter((scene): scene is Scene => Boolean(scene))
}

/** 批次草稿中把某个场次向拍摄前后移动一格；越界或无草稿时原样返回。 */
export function moveInOrder(order: string[], sceneId: string, direction: -1 | 1): string[] {
  const index = order.indexOf(sceneId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= order.length) return order
  const next = [...order]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  return next
}

/** 确认排期前校验：草稿必须与现有场次一一对应，不重不漏。返回 null 表示通过。 */
export function validateScheduleDraft(scenes: Scene[], draft: string[] | null): string | null {
  if (draft === null) return '当前没有进行中的排期批次。'
  if (draft.length !== scenes.length || new Set(draft).size !== draft.length) {
    return '排期草稿与现有场次不一致（可能有场次刚被删除），已为你保留草稿可继续调整。'
  }
  const valid = new Set(scenes.map((scene) => scene.id))
  if (draft.some((sceneId) => !valid.has(sceneId))) {
    return '排期草稿引用了已不存在的场次，已为你保留草稿可继续调整。'
  }
  return null
}

export function deriveWarnings(script: Script): WarningItem[] {
  const warnings: WarningItem[] = []
  // 连续检查始终按故事顺序迭代，与 shootOrder 排期无关。
  const scenes = storyOrderedScenes(script)
  const sceneIndex = (sceneId: string) => scenes.findIndex((scene) => scene.id === sceneId)
  const charactersSeen = new Set<string>()
  const propsSeen = new Set<string>()

  scenes.forEach((scene, index) => {
    scene.characterIds.forEach((characterId) => {
      const character = script.characters.find((item) => item.id === characterId)
      if (!character) return
      const introducedAt = sceneIndex(character.introducedSceneId)
      if (index > 0 && !charactersSeen.has(characterId) && introducedAt >= index) {
        warnings.push({
          id: `character-${scene.id}-${characterId}`,
          type: 'character',
          severity: index > 1 ? 'error' : 'warning',
          sceneId: scene.id,
          title: `${character.name}突然出现`,
          detail: `角色在故事第 ${scene.number} 场首次出现，但故事前序场次没有建立其身份、关系或到场铺垫。`,
          suggestion: `在更早故事场次补充提及、声音或到场动作，并把“首次建立”场次改为相应场次。`
        })
      }
      charactersSeen.add(characterId)
    })

    scene.propIds.forEach((propId) => {
      const prop = script.props.find((item) => item.id === propId)
      if (!prop) return
      const introducedAt = sceneIndex(prop.introducedSceneId)
      if (!propsSeen.has(propId) && introducedAt > index) {
        warnings.push({
          id: `prop-${scene.id}-${propId}`,
          type: 'prop',
          severity: 'error',
          sceneId: scene.id,
          title: `${prop.name}尚未提前建立`,
          detail: `道具在故事第 ${scene.number} 场已出现，但首次建立被标记在故事第 ${scenes[introducedAt]?.number ?? '未知'} 场。`,
          suggestion: '调整首次建立场次，或在当前场次加入来源、交接动作与持有人反应。'
        })
      }
      propsSeen.add(propId)
    })

    Object.entries(scene.costumes).forEach(([characterId, wardrobeId]) => {
      const wardrobe = script.wardrobes.find((item) => item.id === wardrobeId)
      const character = script.characters.find((item) => item.id === characterId)
      if (!wardrobe || !character) return
      if (!wardrobe.timePeriods.includes(scene.dayNight)) {
        warnings.push({
          id: `wardrobe-${scene.id}-${characterId}-${wardrobeId}`,
          type: 'wardrobe',
          severity: 'warning',
          sceneId: scene.id,
          title: `${character.name}服装与时间冲突`,
          detail: `“${wardrobe.name}”只配置用于 ${wardrobe.timePeriods.join('、')}，本场标记为“${scene.dayNight}”。`,
          suggestion: '确认是否跨越时间连续拍摄；如需延续服装，请把当前时段加入服装适用范围。'
        })
      }
    })

    if (index > 0 && scenes[index - 1].storyTime && scene.storyTime && index > 0) {
      const previous = scenes[index - 1]
      const previousDay = previous.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      const currentDay = scene.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      if (previousDay && currentDay && Number(currentDay) < Number(previousDay)) {
        warnings.push({
          id: `timeline-${scene.id}`,
          type: 'timeline',
          severity: 'error',
          sceneId: scene.id,
          title: '时间线出现倒退',
          detail: `故事上一场为第 ${previousDay} 天，本场却标记为第 ${currentDay} 天，可能造成观看顺序混乱。`,
          suggestion: '调整故事时间，或明确使用倒叙并在场次摘要中标注时间跳转。'
        })
      }
    }
  })
  return warnings
}

function orderNumbers(script: Script, order: string[]): string {
  const byId = new Map(script.scenes.map((scene) => [scene.id, scene.number]))
  return order.map((sceneId) => byId.get(sceneId) ?? '?').join(' → ')
}

export function diffScript(base: Script, current: Script): DiffItem[] {
  const fields: Array<{ key: keyof Scene; label: string }> = [
    { key: 'slug', label: '场名' },
    { key: 'synopsis', label: '摘要' },
    { key: 'intExt', label: '内外景' },
    { key: 'location', label: '地点' },
    { key: 'dayNight', label: '日夜' },
    { key: 'storyTime', label: '故事时间' },
    { key: 'pageLength', label: '页数' },
    { key: 'revision', label: '修订色' },
    { key: 'status', label: '状态' },
    { key: 'reason', label: '修改理由' }
  ]
  const result: DiffItem[] = []
  const sceneKey = (scene: Scene) => `${scene.number}|${scene.slug}`
  const baseByKey = new Map(base.scenes.map((scene) => [sceneKey(scene), scene]))
  current.scenes.forEach((scene) => {
    const previous = baseByKey.get(sceneKey(scene)) ?? base.scenes.find((item) => item.id === scene.id)
    if (!previous) {
      result.push({ id: `new-${scene.id}`, sceneNumber: scene.number, field: '场次', before: '不存在', after: `${scene.intExt}. ${scene.location} — ${scene.dayNight}` })
      return
    }
    fields.forEach(({ key, label }) => {
      const before = String(previous[key] ?? '')
      const after = String(scene[key] ?? '')
      if (before !== after) result.push({ id: `${scene.id}-${String(key)}`, sceneNumber: scene.number, field: label, before, after })
    })
  })
  base.scenes.forEach((scene) => {
    if (!current.scenes.some((item) => item.id === scene.id || sceneKey(item) === sceneKey(scene))) {
      result.push({ id: `deleted-${scene.id}`, sceneNumber: scene.number, field: '场次', before: `${scene.intExt}. ${scene.location} — ${scene.dayNight}`, after: '已删除' })
    }
  })

  // 故事顺序（剪辑连续性依据）与拍摄次序分别比较。
  const baseStory = base.scenes.map((scene) => scene.id)
  const currentStory = current.scenes.map((scene) => scene.id)
  if (baseStory.join(',') !== currentStory.join(',')) {
    result.push({ id: 'order-story', sceneNumber: '—', field: '故事顺序', before: orderNumbers(base, baseStory), after: orderNumbers(current, currentStory) })
  }
  const baseShoot = normalizeShootOrder(base.scenes, base.shootOrder)
  const currentShoot = normalizeShootOrder(current.scenes, current.shootOrder)
  if (baseShoot.join(',') !== currentShoot.join(',')) {
    result.push({ id: 'order-shoot', sceneNumber: '—', field: '拍摄次序', before: orderNumbers(base, baseShoot), after: orderNumbers(current, currentShoot) })
  }
  return result
}

export function useContinuityStore() {
  const [state, setState] = useState<ContinuityState>(initialState)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')
  const undoRef = useRef<Script[]>([])
  const redoRef = useRef<Script[]>([])
  // 排期批次内的撤销栈：存放本次批次每次挪动前的草稿。
  const scheduleUndoRef = useRef<string[][]>([])
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    setSaveStatus('saving')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      setSaveStatus('saved')
    }, 160)
    return () => window.clearTimeout(saveTimer.current)
  }, [state])

  // 场次增删后，同步已确认的拍摄次序与进行中的批次草稿，保证两份顺序始终只引用现存场次。
  useEffect(() => {
    setState((previous) => {
      const shootOrder = normalizeShootOrder(previous.script.scenes, previous.script.shootOrder)
      const changed = shootOrder.join(',') !== previous.script.shootOrder.join(',')
      const nextScript = changed ? { ...previous.script, shootOrder } : previous.script
      if (previous.scheduleDraft === null) {
        return changed ? { ...previous, script: nextScript } : previous
      }
      const draft = normalizeShootOrder(previous.script.scenes, previous.scheduleDraft)
      if (!changed && draft.join(',') === previous.scheduleDraft.join(',')) return previous
      return { ...previous, script: nextScript, scheduleDraft: draft }
    })
  }, [state.script.scenes])

  const mutate = useCallback((mutator: (script: Script) => void) => {
    setState((previous) => {
      const next = clone(previous.script)
      mutator(next)
      undoRef.current.push(clone(previous.script))
      if (undoRef.current.length > 80) undoRef.current.shift()
      redoRef.current = []
      return { ...previous, script: next, updatedAt: new Date().toISOString() }
    })
  }, [])

  const undo = useCallback(() => {
    setState((previous) => {
      const target = undoRef.current.pop()
      if (!target) return previous
      redoRef.current.push(clone(previous.script))
      return { ...previous, script: target, updatedAt: new Date().toISOString() }
    })
  }, [])

  const redo = useCallback(() => {
    setState((previous) => {
      const target = redoRef.current.pop()
      if (!target) return previous
      undoRef.current.push(clone(previous.script))
      return { ...previous, script: target, updatedAt: new Date().toISOString() }
    })
  }, [])

  const updateScriptField = useCallback((field: 'title' | 'writer' | 'draft', value: string) => {
    mutate((script) => { script[field] = value })
  }, [mutate])

  const updateScene = useCallback((sceneId: string, field: keyof Scene, value: Scene[keyof Scene]) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (scene) (scene as unknown as Record<string, unknown>)[field] = value
    })
  }, [mutate])

  const toggleSceneRelation = useCallback((sceneId: string, field: 'characterIds' | 'propIds', itemId: string) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      const values = scene[field]
      scene[field] = values.includes(itemId) ? values.filter((value) => value !== itemId) : [...values, itemId]
    })
  }, [mutate])

  const setCostume = useCallback((sceneId: string, characterId: string, wardrobeId: string) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      if (!wardrobeId) delete scene.costumes[characterId]
      else scene.costumes[characterId] = wardrobeId
    })
  }, [mutate])

  // 在故事顺序中前后挪动场次（剪辑室调整叙事结构），拍摄次序以 ID 关联，不受影响。
  const moveScene = useCallback((sceneId: string, direction: -1 | 1) => {
    mutate((script) => {
      const index = script.scenes.findIndex((scene) => scene.id === sceneId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= script.scenes.length) return
      const [scene] = script.scenes.splice(index, 1)
      script.scenes.splice(target, 0, scene)
    })
  }, [mutate])

  const addScene = useCallback(() => {
    const sceneId = id('scene')
    mutate((script) => {
      const number = String(script.scenes.length + 1)
      script.scenes.push({
        id: sceneId, number, slug: '未命名场景', synopsis: '', intExt: 'INT', location: '待填写', dayNight: '白天', storyTime: `第 1 天`, pageLength: 1,
        characterIds: [], propIds: [], costumes: {}, revision: 'white', status: 'draft', reason: ''
      })
      // 新场次默认追加到拍摄次序末尾（若尚未由同步效应补入也无妨，二者幂等）。
      if (!script.shootOrder.includes(sceneId)) script.shootOrder.push(sceneId)
    })
    return sceneId
  }, [mutate])

  const deleteScene = useCallback((sceneId: string) => {
    if (state.script.scenes.length <= 1) return
    mutate((script) => {
      script.scenes = script.scenes.filter((scene) => scene.id !== sceneId)
      script.shootOrder = script.shootOrder.filter((orderId) => orderId !== sceneId)
    })
  }, [mutate, state.script.scenes.length])

  const addCharacter = useCallback(() => {
    mutate((script) => {
      script.characters.push({ id: id('char'), name: '新角色', actor: '待定', introducedSceneId: script.scenes[0]?.id ?? '', note: '' })
    })
  }, [mutate])

  const updateCharacter = useCallback((characterId: string, field: keyof Character, value: string) => {
    mutate((script) => {
      const item = script.characters.find((character) => character.id === characterId)
      if (item) item[field] = value
    })
  }, [mutate])

  const addProp = useCallback(() => {
    mutate((script) => {
      script.props.push({ id: id('prop'), name: '新道具', introducedSceneId: script.scenes[0]?.id ?? '', ownerId: script.characters[0]?.id ?? '', note: '' })
    })
  }, [mutate])

  const updateProp = useCallback((propId: string, field: keyof Prop, value: string) => {
    mutate((script) => {
      const item = script.props.find((prop) => prop.id === propId)
      if (item) item[field] = value
    })
  }, [mutate])

  const addWardrobe = useCallback(() => {
    mutate((script) => {
      script.wardrobes.push({ id: id('ward'), characterId: script.characters[0]?.id ?? '', name: '新服装', timePeriods: ['白天'], note: '' })
    })
  }, [mutate])

  const updateWardrobe = useCallback((wardrobeId: string, field: keyof Wardrobe, value: string | string[]) => {
    mutate((script) => {
      const item = script.wardrobes.find((wardrobe) => wardrobe.id === wardrobeId)
      if (item) {
        if (field === 'timePeriods') item.timePeriods = value as string[]
        else item[field] = value as never
      }
    })
  }, [mutate])

  // ── 排期批次（拍摄次序）─────────────────────────────────────────────
  // 调整先进可撤销的工作批次；确认时才写回 shootOrder 并随版本快照保存，
  // 失败或取消都保留上一份已确认的工作稿（state.script 始终不被批次直接改动）。

  const beginScheduleBatch = useCallback(() => {
    setState((previous) => {
      if (previous.scheduleDraft !== null) return previous
      scheduleUndoRef.current = []
      return { ...previous, scheduleDraft: clone(previous.script.shootOrder) }
    })
  }, [])

  const cancelScheduleBatch = useCallback(() => {
    // 取消：丢弃草稿，继续编辑上一份工作稿（script.shootOrder 从未被改动）。
    scheduleUndoRef.current = []
    setState((previous) => (previous.scheduleDraft === null ? previous : { ...previous, scheduleDraft: null }))
  }, [])

  const moveScheduleScene = useCallback((sceneId: string, direction: -1 | 1) => {
    setState((previous) => {
      if (previous.scheduleDraft === null) return previous
      const draft = moveInOrder(previous.scheduleDraft, sceneId, direction)
      if (draft === previous.scheduleDraft) return previous
      scheduleUndoRef.current.push(clone(previous.scheduleDraft))
      return { ...previous, scheduleDraft: draft }
    })
  }, [])

  const undoScheduleMove = useCallback(() => {
    setState((previous) => {
      if (previous.scheduleDraft === null) return previous
      const target = scheduleUndoRef.current.pop()
      if (!target) return previous
      return { ...previous, scheduleDraft: target }
    })
  }, [])

  const commitScheduleBatch = useCallback((name?: string): { ok: true; version: Version } | { ok: false; error: string } => {
    // 先在当前工作稿上校验；不通过则保留草稿继续编辑，已确认顺序不动。
    const error = validateScheduleDraft(state.script.scenes, state.scheduleDraft)
    if (error) return { ok: false, error }
    const draft = state.scheduleDraft as string[]

    const createdAt = new Date().toISOString()
    const version: Version = {
      id: id('version'),
      name: name?.trim() || `排期确认 · ${new Date().toLocaleString('zh-CN')}`,
      createdAt,
      // 保存的是确认前的既有版本快照（连同当时的拍摄次序），供对照与回滚。
      script: clone(state.script)
    }
    setState((previous) => {
      if (previous.scheduleDraft === null) return previous
      const nextScript: Script = { ...clone(previous.script), shootOrder: clone(previous.scheduleDraft) }
      // 排期不改变故事顺序，故不进入剧本撤销栈；批次本身可通过版本快照回滚。
      return {
        ...previous,
        script: nextScript,
        scheduleDraft: null,
        versions: [version, ...previous.versions],
        updatedAt: createdAt
      }
    })
    scheduleUndoRef.current = []
    return { ok: true, version }
  }, [state.scheduleDraft, state.script])

  const setReviewStatus = useCallback((warningId: string, status: WarningReview['status']) => {
    setState((previous) => ({
      ...previous,
      reviews: {
        ...previous.reviews,
        [warningId]: { ...(previous.reviews[warningId] ?? { replies: [] }), status }
      },
      updatedAt: new Date().toISOString()
    }))
  }, [])

  const addReply = useCallback((warningId: string, author: string, text: string) => {
    if (!text.trim()) return
    const reply: Reply = { id: id('reply'), author, text: text.trim(), createdAt: new Date().toISOString() }
    setState((previous) => ({
      ...previous,
      reviews: {
        ...previous.reviews,
        [warningId]: {
          status: previous.reviews[warningId]?.status ?? 'pending',
          replies: [...(previous.reviews[warningId]?.replies ?? []), reply]
        }
      },
      updatedAt: new Date().toISOString()
    }))
  }, [])

  const createVersion = useCallback((name: string) => {
    const version: Version = { id: id('version'), name: name.trim() || `版本 ${state.versions.length + 1}`, createdAt: new Date().toISOString(), script: clone(state.script) }
    setState((previous) => ({ ...previous, versions: [version, ...previous.versions] }))
    return version
  }, [state.script, state.versions.length])

  const restoreVersion = useCallback((versionId: string) => {
    const version = state.versions.find((item) => item.id === versionId)
    if (!version) return
    // 恢复时同样升级旧快照：缺失 shootOrder 则按其故事次序回填。
    const restored = upgradeScript(clone(version.script))
    mutate((script) => { Object.assign(script, restored) })
  }, [mutate, state.versions])

  const reset = useCallback(() => {
    const fresh = clone(sampleScript)
    mutate((script) => { Object.assign(script, fresh) })
    setState((previous) => ({ ...previous, scheduleDraft: null, reviews: {} }))
  }, [mutate])

  return {
    state,
    saveStatus,
    warnings: deriveWarnings(state.script),
    updateScriptField,
    updateScene,
    toggleSceneRelation,
    setCostume,
    moveScene,
    addScene,
    deleteScene,
    addCharacter,
    updateCharacter,
    addProp,
    updateProp,
    addWardrobe,
    updateWardrobe,
    beginScheduleBatch,
    cancelScheduleBatch,
    moveScheduleScene,
    undoScheduleMove,
    commitScheduleBatch,
    setReviewStatus,
    addReply,
    createVersion,
    restoreVersion,
    undo,
    redo,
    reset
  }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { sampleScript } from './sample'
import type { Character, ContinuityState, DiffItem, Prop, Reply, Scene, ScheduleDraft, Script, Version, Wardrobe, WarningItem, WarningReview } from './types'

const STORAGE_KEY = 'sologsb-1017-continuity-v1'
const clone = <T,>(value: T): T => structuredClone(value)
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/* ------------------------------------------------------------------ */
/* 顺序选择器：scenes 只是身份集合，故事/拍摄顺序一律以 id 数组为准。 */
/* ------------------------------------------------------------------ */

const sceneMap = (script: Script) => new Map(script.scenes.map((scene) => [scene.id, scene]))

/** 按故事顺序返回的场次（连续性检查、大纲、时间线资料库使用）。 */
export const storyScenes = (script: Script): Scene[] =>
  script.storySceneIds.map((sceneId) => sceneMap(script).get(sceneId)).filter((scene): scene is Scene => Boolean(scene))

/** 按拍摄次序返回的场次（剧组排期使用）。 */
export const shootScenes = (script: Script): Scene[] =>
  script.shootSceneIds.map((sceneId) => sceneMap(script).get(sceneId)).filter((scene): scene is Scene => Boolean(scene))

/** 旧数据（含历史版本快照）可能没有顺序数组，按当时数组次序回填，并修复增删场造成的脏 id。 */
export function normalizeScript(raw: Script): Script {
  const scenes = raw.scenes ?? []
  const reconcile = (ids: string[] | undefined, fallback: string[]): string[] => {
    const valid = new Set(scenes.map((scene) => scene.id))
    const seen = new Set<string>()
    const result: string[] = []
    for (const sceneId of ids ?? fallback) {
      if (valid.has(sceneId) && !seen.has(sceneId)) {
        seen.add(sceneId)
        result.push(sceneId)
      }
    }
    for (const scene of scenes) {
      if (!seen.has(scene.id)) result.push(scene.id)
    }
    return result
  }
  const legacyOrder = scenes.map((scene) => scene.id)
  return {
    ...raw,
    scenes,
    storySceneIds: reconcile(raw.storySceneIds, legacyOrder),
    shootSceneIds: reconcile(raw.shootSceneIds, raw.storySceneIds ?? legacyOrder)
  }
}

function repairScheduleDraft(draft: ScheduleDraft, script: Script): ScheduleDraft {
  const reconcile = (ids: string[]) => {
    const valid = new Set(script.scenes.map((scene) => scene.id))
    const seen = new Set<string>()
    const result: string[] = []
    for (const sceneId of ids) {
      if (valid.has(sceneId) && !seen.has(sceneId)) {
        seen.add(sceneId)
        result.push(sceneId)
      }
    }
    // 批次进行中新增的场次按已确认的拍摄次序补到队尾，避免确认时出现场次缺失。
    for (const sceneId of script.shootSceneIds) {
      if (!seen.has(sceneId)) result.push(sceneId)
    }
    return result
  }
  return {
    ...draft,
    baseShootSceneIds: reconcile(draft.baseShootSceneIds),
    draftShootSceneIds: reconcile(draft.draftShootSceneIds),
    moves: draft.moves.filter((move) => validScene(script, move.sceneId)),
    undoStack: draft.undoStack.map(reconcile)
  }
}

const validScene = (script: Script, sceneId: string) => script.scenes.some((scene) => scene.id === sceneId)

function migrateState(parsed: Partial<ContinuityState>): ContinuityState {
  const script = normalizeScript(parsed.script as Script)
  return {
    script,
    reviews: parsed.reviews ?? {},
    versions: (parsed.versions ?? []).map((version) => ({ ...version, script: normalizeScript(version.script) })),
    scheduleDraft: parsed.scheduleDraft ? repairScheduleDraft(parsed.scheduleDraft, script) : null,
    updatedAt: parsed.updatedAt ?? new Date().toISOString()
  }
}

function initialState(): ContinuityState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ContinuityState>
      if (parsed.script?.scenes?.length) return migrateState(parsed)
    }
  } catch {
    // Ignore an invalid local draft and restore the bundled example.
  }
  return { script: clone(sampleScript), reviews: {}, versions: [], scheduleDraft: null, updatedAt: new Date().toISOString() }
}

export function deriveWarnings(script: Script): WarningItem[] {
  const warnings: WarningItem[] = []
  const ordered = storyScenes(script)
  const sceneIndex = (sceneId: string) => ordered.findIndex((scene) => scene.id === sceneId)
  const charactersSeen = new Set<string>()
  const propsSeen = new Set<string>()

  ordered.forEach((scene, index) => {
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
          detail: `角色在故事第 ${index + 1} 场（场号 ${scene.number}）首次出现，但故事顺序上的前序场景没有建立其身份、关系或到场铺垫。`,
          suggestion: `在更早场景补充提及、声音或到场动作，并把“首次建立”场景改为相应场次。`
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
          detail: `道具在故事第 ${index + 1} 场（场号 ${scene.number}）已出现，但首次建立被标记在故事第 ${introducedAt + 1} 场（${ordered[introducedAt]?.number ?? '未知'}）。`,
          suggestion: '调整首次建立场景，或在当前场景加入来源、交接动作与持有人反应。'
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

    if (index > 0 && ordered[index - 1].storyTime && scene.storyTime) {
      const previous = ordered[index - 1]
      const previousDay = previous.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      const currentDay = scene.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      if (previousDay && currentDay && Number(currentDay) < Number(previousDay)) {
        warnings.push({
          id: `timeline-${scene.id}`,
          type: 'timeline',
          severity: 'error',
          sceneId: scene.id,
          title: '时间线出现倒退',
          detail: `故事顺序上一场（场号 ${previous.number}）为第 ${previousDay} 天，本场（${scene.number}）却标记为第 ${currentDay} 天，可能造成观看顺序混乱。`,
          suggestion: '调整故事时间，或明确使用倒叙并在场次摘要中标注时间跳转。'
        })
      }
    }
  })
  return warnings
}

const orderLabel = (index: number) => (index < 0 ? '不在序列中' : `第 ${index + 1} 位`)

/** 逐字段比较两个剧本，场次以稳定 id 关联，并额外比较故事顺序与拍摄次序。 */
export function diffScript(baseSource: Script, currentSource: Script): DiffItem[] {
  const base = normalizeScript(baseSource)
  const current = normalizeScript(currentSource)
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
  const baseById = new Map(base.scenes.map((scene) => [scene.id, scene]))
  const currentById = new Map(current.scenes.map((scene) => [scene.id, scene]))
  const baseByKey = new Map(base.scenes.map((scene) => [sceneKey(scene), scene]))

  const pushOrderDiffs = (baseIds: string[], currentIds: string[], field: string, rowPrefix: string) => {
    currentIds.forEach((sceneId, index) => {
      const beforeIndex = baseIds.indexOf(sceneId)
      if (beforeIndex !== index) {
        const scene = currentById.get(sceneId) ?? baseById.get(sceneId)
        result.push({ id: `${rowPrefix}-${sceneId}`, sceneNumber: scene?.number ?? '-', field, before: orderLabel(beforeIndex), after: orderLabel(index) })
      }
    })
    baseIds.forEach((sceneId, index) => {
      if (!currentIds.includes(sceneId)) {
        const scene = baseById.get(sceneId)
        result.push({ id: `${rowPrefix}-${sceneId}`, sceneNumber: scene?.number ?? '-', field, before: orderLabel(index), after: orderLabel(-1) })
      }
    })
  }

  current.scenes.forEach((scene) => {
    const previous = baseById.get(scene.id) ?? baseByKey.get(sceneKey(scene))
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
  pushOrderDiffs(base.storySceneIds, current.storySceneIds, '故事顺序', 'order-story')
  pushOrderDiffs(base.shootSceneIds, current.shootSceneIds, '拍摄次序', 'order-shoot')
  return result
}

export interface ScheduleConfirmResult {
  ok: boolean
  error?: string
  version?: Version
}

export function useContinuityStore() {
  const [state, setState] = useState<ContinuityState>(initialState)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')
  const undoRef = useRef<Script[]>([])
  const redoRef = useRef<Script[]>([])
  const saveTimer = useRef<number | undefined>(undefined)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    setSaveStatus('saving')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      setSaveStatus('saved')
    }, 160)
    return () => window.clearTimeout(saveTimer.current)
  }, [state])

  /** 普通字段编辑；顺带修复顺序数组，并让进行中的排期批次与场次增删保持一致。 */
  const mutate = useCallback((mutator: (script: Script) => void) => {
    setState((previous) => {
      const next = normalizeScript(clone(previous.script))
      mutator(next)
      const repaired = normalizeScript(next)
      return {
        ...previous,
        script: repaired,
        scheduleDraft: previous.scheduleDraft ? repairScheduleDraft(clone(previous.scheduleDraft), repaired) : null,
        updatedAt: new Date().toISOString()
      }
    })
  }, [])

  const undo = useCallback(() => {
    setState((previous) => {
      const target = undoRef.current.pop()
      if (!target) return previous
      redoRef.current.push(clone(previous.script))
      return { ...previous, script: normalizeScript(target), scheduleDraft: null, updatedAt: new Date().toISOString() }
    })
  }, [])

  const redo = useCallback(() => {
    setState((previous) => {
      const target = redoRef.current.pop()
      if (!target) return previous
      undoRef.current.push(clone(previous.script))
      return { ...previous, script: normalizeScript(target), scheduleDraft: null, updatedAt: new Date().toISOString() }
    })
  }, [])

  const pushHistory = useCallback((previous: ContinuityState) => {
    undoRef.current.push(clone(previous.script))
    if (undoRef.current.length > 80) undoRef.current.shift()
    redoRef.current = []
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

  /** 调整的是故事顺序（大纲、连续性检查与时间线依据），场次身份不变。 */
  const moveScene = useCallback((sceneId: string, direction: -1 | 1) => {
    mutate((script) => {
      const index = script.storySceneIds.indexOf(sceneId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= script.storySceneIds.length) return
      const [moved] = script.storySceneIds.splice(index, 1)
      script.storySceneIds.splice(target, 0, moved)
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
      // 新场次同时进入故事顺序与拍摄次序；若排期批次进行中，由 repairScheduleDraft 补入草稿。
      script.storySceneIds.push(sceneId)
      script.shootSceneIds.push(sceneId)
    })
    return sceneId
  }, [mutate])

  const deleteScene = useCallback((sceneId: string) => {
    if (state.script.scenes.length <= 1) return
    mutate((script) => {
      script.scenes = script.scenes.filter((scene) => scene.id !== sceneId)
      script.storySceneIds = script.storySceneIds.filter((value) => value !== sceneId)
      script.shootSceneIds = script.shootSceneIds.filter((value) => value !== sceneId)
    })
  }, [mutate, state.script.scenes.length])

  const addCharacter = useCallback(() => {
    mutate((script) => {
      script.characters.push({ id: id('char'), name: '新角色', actor: '待定', introducedSceneId: script.storySceneIds[0] ?? '', note: '' })
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
      script.props.push({ id: id('prop'), name: '新道具', introducedSceneId: script.storySceneIds[0] ?? '', ownerId: script.characters[0]?.id ?? '', note: '' })
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

  /* ----------------------- 排期调整（可撤销批次） ----------------------- */

  const startScheduleBatch = useCallback(() => {
    setState((previous) => previous.scheduleDraft
      ? previous
      : {
          ...previous,
          scheduleDraft: {
            id: id('schedule'),
            startedAt: new Date().toISOString(),
            baseShootSceneIds: clone(previous.script.shootSceneIds),
            draftShootSceneIds: clone(previous.script.shootSceneIds),
            moves: [],
            undoStack: []
          },
          updatedAt: new Date().toISOString()
        })
  }, [])

  const moveScheduleScene = useCallback((sceneId: string, direction: -1 | 1) => {
    setState((previous) => {
      const draft = previous.scheduleDraft
      if (!draft) return previous
      const order = clone(draft.draftShootSceneIds)
      const index = order.indexOf(sceneId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= order.length) return previous
      const undoStack = [...draft.undoStack, clone(draft.draftShootSceneIds)].slice(-200)
      const [moved] = order.splice(index, 1)
      order.splice(target, 0, moved)
      return {
        ...previous,
        scheduleDraft: {
          ...draft,
          draftShootSceneIds: order,
          moves: [...draft.moves, { sceneId: moved, from: index, to: target }],
          undoStack
        },
        updatedAt: new Date().toISOString()
      }
    })
  }, [])

  const undoScheduleMove = useCallback(() => {
    setState((previous) => {
      const draft = previous.scheduleDraft
      if (!draft || !draft.undoStack.length) return previous
      const undoStack = clone(draft.undoStack)
      const previousOrder = undoStack.pop()!
      return {
        ...previous,
        scheduleDraft: {
          ...draft,
          draftShootSceneIds: previousOrder,
          moves: draft.moves.slice(0, -1),
          undoStack
        },
        updatedAt: new Date().toISOString()
      }
    })
  }, [])

  /** 取消批次：丢弃草稿，继续编辑上一份工作稿。 */
  const cancelScheduleBatch = useCallback(() => {
    setState((previous) => previous.scheduleDraft
      ? { ...previous, scheduleDraft: null, updatedAt: new Date().toISOString() }
      : previous)
  }, [])

  /**
   * 确认批次：先校验草稿是当前场次的一个合法排列，
   * 通过才写回拍摄次序，并与既有版本快照一起保存一个自动命名快照；
   * 校验失败时保留草稿与工作稿原样，返回错误信息供界面提示。
   */
  const confirmScheduleBatch = useCallback((name?: string): ScheduleConfirmResult => {
    const previous = stateRef.current
    const draft = previous.scheduleDraft
    if (!draft) return { ok: false, error: '没有进行中的排期批次。' }
    const sceneIds = previous.script.scenes.map((scene) => scene.id)
    const sameLength = draft.draftShootSceneIds.length === sceneIds.length
    const sameSet = sameLength && sceneIds.every((sceneId) => draft.draftShootSceneIds.includes(sceneId))
    const noDuplicates = new Set(draft.draftShootSceneIds).size === draft.draftShootSceneIds.length
    if (!sameLength || !sameSet || !noDuplicates) {
      return { ok: false, error: '排期草稿与当前场次不一致（存在缺失、重复或未纳入的场次），无法确认。草稿已保留，请修正后重试。' }
    }

    const next: Script = normalizeScript({ ...clone(previous.script), shootSceneIds: clone(draft.draftShootSceneIds) })
    const stamp = new Date()
    const version: Version = {
      id: id('version'),
      name: name?.trim() || `排期批次 · ${stamp.toLocaleString('zh-CN', { hour12: false })}`,
      createdAt: stamp.toISOString(),
      script: clone(next)
    }
    pushHistory(previous)
    setState((current) => ({
      ...current,
      script: next,
      scheduleDraft: null,
      versions: [version, ...current.versions],
      updatedAt: new Date().toISOString()
    }))
    return { ok: true, version }
  }, [pushHistory])

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
    const script = normalizeScript(clone(stateRef.current.script))
    const version: Version = { id: id('version'), name: name.trim() || `版本 ${stateRef.current.versions.length + 1}`, createdAt: new Date().toISOString(), script }
    setState((previous) => ({ ...previous, versions: [version, ...previous.versions] }))
    return version
  }, [])

  const restoreVersion = useCallback((versionId: string) => {
    setState((previous) => {
      const version = previous.versions.find((item) => item.id === versionId)
      if (!version) return previous
      pushHistory(previous)
      // 恢复历史快照会同时回到该版本的故事/拍摄顺序，进行中的排期批次作废。
      return { ...previous, script: normalizeScript(clone(version.script)), scheduleDraft: null, updatedAt: new Date().toISOString() }
    })
  }, [pushHistory])

  const reset = useCallback(() => {
    setState((previous) => {
      pushHistory(previous)
      return { ...previous, script: clone(sampleScript), reviews: {}, scheduleDraft: null, updatedAt: new Date().toISOString() }
    })
  }, [pushHistory])

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
    startScheduleBatch,
    moveScheduleScene,
    undoScheduleMove,
    cancelScheduleBatch,
    confirmScheduleBatch,
    setReviewStatus,
    addReply,
    createVersion,
    restoreVersion,
    undo,
    redo,
    reset
  }
}

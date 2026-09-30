export type RevisionColor = 'white' | 'blue' | 'pink' | 'yellow' | 'green' | 'goldenrod' | 'buff' | 'salmon' | 'cherry'
export type WarningStatus = 'pending' | 'accepted' | 'ignored'
export type WarningType = 'character' | 'prop' | 'wardrobe' | 'timeline'

export interface Character {
  id: string
  name: string
  actor: string
  introducedSceneId: string
  note: string
}

export interface Prop {
  id: string
  name: string
  introducedSceneId: string
  ownerId: string
  note: string
}

export interface Wardrobe {
  id: string
  characterId: string
  name: string
  timePeriods: string[]
  note: string
}

export interface Scene {
  id: string
  number: string
  slug: string
  synopsis: string
  intExt: 'INT' | 'EXT' | 'INT/EXT'
  location: string
  dayNight: string
  storyTime: string
  pageLength: number
  characterIds: string[]
  propIds: string[]
  costumes: Record<string, string>
  revision: RevisionColor
  status: 'draft' | 'review' | 'locked'
  reason: string
}

export interface Script {
  title: string
  writer: string
  draft: string
  /** 稳定的场次身份集合，数组顺序不再代表故事或拍摄顺序。 */
  scenes: Scene[]
  /** 故事顺序：连续性检查、时间线、大纲与角色/道具铺垫均按此遍历。 */
  storySceneIds: string[]
  /** 拍摄次序：剧组排期使用，与故事顺序独立维护。 */
  shootSceneIds: string[]
  characters: Character[]
  props: Prop[]
  wardrobes: Wardrobe[]
}

export interface WarningItem {
  id: string
  type: WarningType
  severity: 'error' | 'warning'
  sceneId: string
  title: string
  detail: string
  suggestion: string
}

export interface Reply {
  id: string
  author: string
  text: string
  createdAt: string
}

export interface WarningReview {
  status: WarningStatus
  replies: Reply[]
}

export interface Version {
  id: string
  name: string
  createdAt: string
  script: Script
}

/**
 * 排期调整批次：进入批次后只改 draftShootSceneIds，
 * 确认成功才写回 script.shootSceneIds；取消或校验失败则丢弃，工作稿保持不变。
 */
export interface ScheduleDraft {
  id: string
  startedAt: string
  /** 批次开始时的拍摄次序，取消即回到这里。 */
  baseShootSceneIds: string[]
  /** 批次内的工作次序，随每次挪动更新。 */
  draftShootSceneIds: string[]
  /** 已确认的挪动步骤（供界面展示与撤销定位）。 */
  moves: Array<{ sceneId: string; from: number; to: number }>
  /** 单步撤销栈，保存每次挪动之前的工作次序。 */
  undoStack: string[][]
}

export interface ContinuityState {
  script: Script
  reviews: Record<string, WarningReview>
  versions: Version[]
  scheduleDraft: ScheduleDraft | null
  updatedAt: string
}

export interface DiffItem {
  id: string
  sceneNumber: string
  field: string
  before: string
  after: string
}

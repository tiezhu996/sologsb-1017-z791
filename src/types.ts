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
  /** 数组顺序即故事顺序，剪辑室据此判断连续性。 */
  scenes: Scene[]
  /**
   * 拍摄次序：按拍摄先后排列的场次 ID。
   * 剧组挪排期只改这里，不改 scenes 的故事顺序。
   */
  shootOrder: string[]
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

export interface ContinuityState {
  script: Script
  /**
   * 未确认的排期批次：按拍摄先后排列的场次 ID 草稿。
   * null 表示没有进行中的批次；确认后写回 script.shootOrder，取消则丢弃。
   */
  scheduleDraft: string[] | null
  reviews: Record<string, WarningReview>
  versions: Version[]
  updatedAt: string
}

export interface DiffItem {
  id: string
  sceneNumber: string
  field: string
  before: string
  after: string
}

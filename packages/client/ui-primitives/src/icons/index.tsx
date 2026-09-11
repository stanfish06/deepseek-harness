/**
 * Icon set for the dsh web UI
 */
import type { Icon as PhosphorIcon, IconWeight } from '@phosphor-icons/react'
import {
  AlarmIcon,
  ArchiveIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  ArrowsClockwiseIcon,
  ArrowsOutIcon,
  BrainIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  CheckIcon,
  CircleNotchIcon,
  ClipboardTextIcon,
  ClockIcon,
  CodeIcon,
  CompassIcon,
  CopyIcon,
  DatabaseIcon,
  DesktopIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  ExportIcon,
  EyeIcon,
  FolderSimpleIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GaugeIcon,
  GearIcon,
  GitBranchIcon,
  GlobeIcon,
  HardDrivesIcon,
  LightningIcon,
  LinkIcon,
  ListChecksIcon,
  ListPlusIcon,
  MagicWandIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  NotePencilIcon,
  PaperclipIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlugsIcon,
  PlusIcon,
  PuzzlePieceIcon,
  QuestionIcon,
  QueueIcon,
  RobotIcon,
  SidebarSimpleIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  StackIcon,
  StopIcon,
  SunIcon,
  TargetIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TrashIcon,
  UserIcon,
  WarningIcon,
  XSquareIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { IconProps } from './props.ts'

export type { IconProps } from './props.ts'

function phosphor(
  Glyph: PhosphorIcon,
  drawnSize: number,
  weight: IconWeight = 'regular',
) {
  return ({ size = drawnSize, className }: IconProps) => (
    <Glyph size={size} className={className} weight={weight} />
  )
}

export const IconNewChatOutline16 = phosphor(NotePencilIcon, 16)

export const IconSearchOutline16 = phosphor(MagnifyingGlassIcon, 16)

export const IconGlobeOutline14 = phosphor(GlobeIcon, 14)

export const IconSettingsOutline14 = phosphor(GearIcon, 14)

export const IconSettingsOutline16 = phosphor(GearIcon, 16)

export const IconPanelLeftOutline16 = phosphor(SidebarSimpleIcon, 16)

export const IconEllipsisOutline16 = phosphor(DotsThreeIcon, 16)

export const IconPlusOutline16 = phosphor(PlusIcon, 16)
export const IconCheckOutline16 = phosphor(CheckIcon, 16)

export const IconCheckOutline14 = phosphor(CheckIcon, 14)
export const IconBranchOutline16 = phosphor(GitBranchIcon, 16)
export const IconChevronDownOutline14 = phosphor(CaretDownIcon, 14)
export const IconChevronLeftOutline14 = phosphor(CaretLeftIcon, 14)
export const IconChevronRightOutline14 = phosphor(CaretRightIcon, 14)
export const IconTriangleRightFill14 = phosphor(CaretRightIcon, 14, 'fill')
export const IconChevronUpOutline14 = phosphor(CaretUpIcon, 14)
export const IconCloseOutline16 = phosphor(XIcon, 16)
export const IconCloseFill14 = phosphor(XSquareIcon, 14, 'fill')
export const IconCopyOutline16 = phosphor(CopyIcon, 16)
export const IconRefreshOutline16 = phosphor(ArrowsClockwiseIcon, 16)
export const IconRefreshOutline14 = phosphor(ArrowsClockwiseIcon, 14)
export const IconLikeOutline16 = phosphor(ThumbsUpIcon, 16)
export const IconLikeFill16 = phosphor(ThumbsUpIcon, 16, 'fill')
export const IconDislikeOutline16 = phosphor(ThumbsDownIcon, 16)
export const IconDislikeFill16 = phosphor(ThumbsDownIcon, 16, 'fill')
export const IconShareOutline16 = phosphor(ExportIcon, 16)
export const IconEditOutline16 = phosphor(PencilSimpleIcon, 16)
export const IconThinkOutline14 = phosphor(BrainIcon, 14)
export const IconThinkOutline16 = phosphor(BrainIcon, 16)
export const IconAgentPresetOutline16 = phosphor(RobotIcon, 16)
export const IconBrowseOutline16 = phosphor(CompassIcon, 16)
export const IconContextInjectionOutline16 = phosphor(StackIcon, 16)
export const IconLinkOutline14 = phosphor(LinkIcon, 14)
export const IconLinkOutline16 = phosphor(LinkIcon, 16)
export const IconRightUpOutline14 = phosphor(ArrowUpRightIcon, 14)
export const IconRightUpOutline16 = phosphor(ArrowUpRightIcon, 16)
export const IconEnhanceOutline16 = phosphor(MagicWandIcon, 16)
export const IconTrashOutline16 = phosphor(TrashIcon, 16)
export const IconWarningOutline16 = phosphor(WarningIcon, 16)
export const IconUserOutline16 = phosphor(UserIcon, 16)
export const IconSendOutline16 = phosphor(ArrowUpIcon, 16)
export const IconStopFill16 = phosphor(StopIcon, 16, 'fill')
export const IconPaperclipOutline16 = phosphor(PaperclipIcon, 16)
export const IconLoadingOutline16 = phosphor(CircleNotchIcon, 16)
export const IconDownloadOutline16 = phosphor(DownloadSimpleIcon, 16)
export const IconPlayOutline16 = phosphor(PlayIcon, 16)
export const IconPauseOutline16 = phosphor(PauseIcon, 16)
export const IconFullscreenOutline16 = phosphor(ArrowsOutIcon, 16)
export const IconCodeOutline16 = phosphor(CodeIcon, 16)
export const IconCordisPluginOutline14 = phosphor(PuzzlePieceIcon, 14)
export const IconApiOutline14 = phosphor(PlugsIcon, 14)
export const IconPersonalizationOutline16 = phosphor(SlidersHorizontalIcon, 16)
export const IconProjectAddOutline16 = phosphor(FolderPlusIcon, 16)
export const IconFolderOpenOutline16 = phosphor(FolderOpenIcon, 16)
export const IconFolderOpen16 = phosphor(FolderOpenIcon, 16)
export const IconFolderClose16 = phosphor(FolderSimpleIcon, 16)
export const IconLightOutline16 = phosphor(SunIcon, 16)
export const IconDarkOutline16 = phosphor(MoonIcon, 16)
export const IconFollowsystemOutline16 = phosphor(DesktopIcon, 16)
export const IconDataOutline16 = phosphor(HardDrivesIcon, 16)
export const IconDatabaseOutline16 = phosphor(DatabaseIcon, 16)
export const IconClockOutline16 = phosphor(ClockIcon, 16)
export const IconGaugeOutline16 = phosphor(GaugeIcon, 16)
export const IconSendOutline14 = phosphor(ArrowUpIcon, 14)
export const IconQueueOutline14 = phosphor(QueueIcon, 14)
export const IconChecklistOutline14 = phosphor(ListChecksIcon, 14)
export const IconListPenOutline16 = phosphor(ListPlusIcon, 16)
export const IconGoalOutline16 = phosphor(TargetIcon, 16)
export const IconSparkle16 = phosphor(SparkleIcon, 16)
export const IconInspectOutline12 = phosphor(EyeIcon, 12)
export const IconSkillOutline16 = phosphor(LightningIcon, 16)
export const IconQuestionOutline14 = phosphor(QuestionIcon, 14)
export const IconAlarmClockOutline16 = phosphor(AlarmIcon, 16)
export const IconArchiveOutline20 = phosphor(ArchiveIcon, 20)

export const IconPlanOutline14 = phosphor(ClipboardTextIcon, 14)
export const IconTreeCorner8x10 = ({ size = 10, className }: IconProps) => (
  <svg
    width={(size * 8) / 10}
    height={size}
    className={className}
    viewBox="-0.5 0 8.5 10.5"
    fill="none"
  >
    <path
      d="M0 0L-0.5 0L-0.5 7L0 7L0.5 7L0.5 0L0 0ZM3 10L3 10.5L8 10.5L8 10L8 9.5L3 9.5L3 10ZM0 7L-0.5 7C-0.5 8.933 1.067 10.5 3 10.5L3 10L3 9.5C1.61929 9.5 0.5 8.38071 0.5 7L0 7Z"
      fill="currentColor"
    />
  </svg>
)

export const IconCompactOutline16 = ({ size = 16, className }: IconProps) => (
  <svg
    width={size}
    height={size}
    className={className}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle
      cx="8"
      cy="8"
      r="6.4"
      stroke="currentColor"
      strokeWidth="1.6"
      opacity="0.35"
    />
    <path
      d="M8 1.6A6.4 6.4 0 0 1 14.4 8"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
)

export const SHIELD_OUTLINE_PATH =
  'M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z'

export const SHIELD_OUTLINE_STROKE = '1.31831'

export const IconShieldOutline16 = ({ size = 16, className }: IconProps) => (
  <svg
    width={size}
    height={size}
    className={className}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d={SHIELD_OUTLINE_PATH}
      stroke="currentColor"
      strokeWidth={SHIELD_OUTLINE_STROKE}
      strokeLinejoin="round"
    />
  </svg>
)

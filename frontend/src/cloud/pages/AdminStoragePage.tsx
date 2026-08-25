import { useCallback, useEffect, useState } from 'react'
import { cloudApi, formatBytes, toCloudError } from '../api'
import { Empty, toast } from '../components/ui'

type StorageReport = {
  storage: {
    originals: number
    derived: number
    staging: number
    free: number
    quotaMax: number
    minFree: number
    derivedMax: number
  }
  dedupSavedBytes: number
  logicalBytes: number
  counts: { spaces: number; files: number; trashed: number; objects: number; failedFiles: number; pendingUploads: number }
  queues: Record<string, { waiting: number; active: number; failed: number; delayed: number }>
  failedJobs: { queue: string; id: string; name: string; reason: string; failedAt: number | null }[]
  config: { root: string; trashRetentionDays: number; uploadTtlHours: number; maxFileBytes: number; xaccel: boolean }
}

/** Статус хранилища для оператора. Не публичный экран (CLOUD_ADMIN_USERNAMES). */
export default function AdminStoragePage() {
  const [report, setReport] = useState<StorageReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { data } = await cloudApi.get<StorageReport>('/admin/storage')
      setReport(data)
    } catch (err) {
      setError(toCloudError(err).message)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 20_000)
    return () => clearInterval(t)
  }, [load])

  const run = async (task: string) => {
    setBusy(task)
    try {
      await cloudApi.post(`/admin/maintenance/${task}`)
      toast.success('Задача поставлена в очередь')
    } catch (err) {
      toast.error(toCloudError(err).message)
    } finally {
      setBusy(null)
    }
  }

  if (error) return <div className="cl-page narrow"><Empty title="Нет доступа" text={error} /></div>
  if (!report) return <div className="cl-page"><div className="cl-skeleton" style={{ height: 260 }} /></div>

  const s = report.storage
  /*
   * Считаем ровно то, что считает assertCanAccept: оригиналы ПЛЮС незавершённые
   * загрузки. Полоса по одним оригиналам показывала «480 ГБ из 520» в тот
   * момент, когда сервер уже отвечал «Достигнута квота Cloud», — по дашборду
   * выходило, что места полно.
   */
  const usedBytes = s.originals + s.staging
  const usedOfQuota = Math.min(100, (usedBytes / Math.max(1, s.quotaMax)) * 100)
  const lowSpace = s.free < s.minFree
  const quotaTight = usedBytes >= s.quotaMax

  return (
    <div className="cl-page narrow">
      <h1 className="cl-h1" style={{ marginBottom: 20 }}>
        Хранилище
      </h1>

      {lowSpace ? (
        <div className="cl-toast error" style={{ marginBottom: 16 }}>
          Свободного места меньше обязательного резерва ({formatBytes(s.minFree)}) — новые загрузки отклоняются.
        </div>
      ) : null}
      {quotaTight ? (
        <div className="cl-toast error" style={{ marginBottom: 16 }}>
          Квота выбрана полностью — новые загрузки отклоняются. Освободите место или поднимите
          CLOUD_STORAGE_MAX_BYTES.
        </div>
      ) : null}

      <div className="cl-bar" style={{ marginBottom: 10 }}>
        <i style={{ width: `${usedOfQuota}%`, background: lowSpace || quotaTight ? 'var(--danger)' : 'var(--brand)' }} />
      </div>
      <div className="cl-muted cl-mono" style={{ fontSize: 12.5, marginBottom: 20 }}>
        {formatBytes(usedBytes)} из квоты {formatBytes(s.quotaMax)} ({Math.round(usedOfQuota)}%)
        {s.staging > 0 ? ` · в том числе ${formatBytes(s.staging)} в незавершённых загрузках` : ''}
      </div>

      <dl style={{ margin: 0 }}>
        <Row label="Оригиналы" value={formatBytes(s.originals)} />
        <Row label="Производные (кэш)" value={`${formatBytes(s.derived)} из ${formatBytes(s.derivedMax)}`} />
        <Row label="Незавершённые загрузки" value={formatBytes(s.staging)} />
        <Row label="Свободно на диске" value={formatBytes(s.free)} />
        <Row label="Логический объём" value={formatBytes(report.logicalBytes)} />
        <Row label="Сэкономлено дедупликацией" value={formatBytes(report.dedupSavedBytes)} />
      </dl>

      <div className="cl-section-title">Объекты</div>
      <dl style={{ margin: 0 }}>
        <Row label="Хуяпки" value={String(report.counts.spaces)} />
        <Row label="Файлов" value={String(report.counts.files)} />
        <Row label="В корзине" value={`${report.counts.trashed} (хранятся ${report.config.trashRetentionDays} дн.)`} />
        <Row label="Физических объектов" value={String(report.counts.objects)} />
        <Row label="Загрузок в процессе" value={String(report.counts.pendingUploads)} />
        <Row label="Файлов с ошибкой обработки" value={String(report.counts.failedFiles)} />
      </dl>

      <div className="cl-section-title">Очереди</div>
      <dl style={{ margin: 0 }}>
        {Object.entries(report.queues).map(([name, stats]) => (
          <Row
            key={name}
            label={name}
            value={`ожидают ${stats.waiting} · выполняются ${stats.active} · отложены ${stats.delayed} · ошибок ${stats.failed}`}
          />
        ))}
      </dl>

      {report.failedJobs.length > 0 ? (
        <>
          <div className="cl-section-title">Упавшие задачи</div>
          {report.failedJobs.map((job) => (
            <div key={`${job.queue}-${job.id}`} className="cl-mi-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
              <div style={{ fontSize: 12.5 }}>
                {job.queue} · {job.id}
              </div>
              <div className="cl-muted" style={{ fontSize: 11.5, wordBreak: 'break-word' }}>
                {job.reason}
              </div>
            </div>
          ))}
        </>
      ) : null}

      <div className="cl-section-title">Обслуживание</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(
          [
            ['upload-gc', 'Убрать протухшие загрузки'],
            ['trash-purge', 'Очистить корзину по сроку'],
            ['refcount-audit', 'Сверить счётчики ссылок'],
            ['derived-gc', 'Подрезать кэш превью'],
          ] as const
        ).map(([task, label]) => (
          <button key={task} className="cl-btn sm" disabled={busy === task} onClick={() => void run(task)}>
            {label}
          </button>
        ))}
      </div>

      <div className="cl-muted" style={{ fontSize: 12, marginTop: 22, lineHeight: 1.6 }}>
        Хранилище: <code>{report.config.root}</code> · отдача через nginx: {report.config.xaccel ? 'да' : 'нет'} · лимит
        файла {formatBytes(report.config.maxFileBytes)} · незавершённая загрузка живёт {report.config.uploadTtlHours} ч.
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="cl-mi-row">
      <dt>{label}</dt>
      <dd className="cl-mono">{value}</dd>
    </div>
  )
}

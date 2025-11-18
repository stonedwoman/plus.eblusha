import { Router, type Request } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { authenticate } from '../middlewares/auth'

const router = Router()

const uploadDir = path.join(process.cwd(), 'uploads')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })

const storage = multer.diskStorage({
  destination: (_req: Request, _file: Express.Multer.File, cb: any) => cb(null, uploadDir),
  filename: (_req: Request, file: Express.Multer.File, cb: any) => {
    const ext = path.extname(file.originalname || '') || '.png'
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    cb(null, name)
  }
})

// Increase max size to 100MB to support typical documents/archives
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } })

router.use(authenticate)

router.post('/', upload.single('file'), (req: Request, res) => {
  const file = (req as any).file as Express.Multer.File | undefined
  if (!file) {
    res.status(400).json({ message: 'No file' })
    return
  }
  // Serve via static mapping under /uploads
  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim()
  const protocol = forwardedProto || req.protocol
  const host = forwardedHost || req.get('host') || req.hostname
  const relativeUrl = `/api/uploads/${file.filename}`
  const origin = host ? `${protocol}://${host}` : undefined
  const absoluteUrl = origin ? new URL(relativeUrl, origin).toString() : relativeUrl
  res.json({ url: absoluteUrl, path: relativeUrl })
})

export default router



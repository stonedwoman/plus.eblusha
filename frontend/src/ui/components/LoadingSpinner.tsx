import './LoadingSpinner.css'
import { motion } from 'framer-motion'

export default function LoadingSpinner(props: { done?: boolean }) {
  const done = !!props?.done
  return (
    <div className="eb-loader">
      <div className={`eb-coin ${done ? 'eb-coin--done' : ''}`}>
        <span className="eb-e">Е</span>
        <span className="eb-b">Б</span>
        {done && (
          <svg className="eb-check" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <motion.path
              d="M5 13L9 17L19 7"
              stroke="var(--brand)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="40"
              initial={{ strokeDashoffset: 40 }}
              animate={{ strokeDashoffset: 0 }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </svg>
        )}
      </div>
    </div>
  )
}


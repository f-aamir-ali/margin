import { motion } from 'motion/react';
import { BookOpen, FilePlus2, FolderOpen, Upload } from 'lucide-react';
import { runCommand } from '../lib/commands';
import { dirName } from '../lib/platform';
import { useApp } from '../lib/store';
import { Keys, SPRING_SOFT } from './ui/controls';

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045, delayChildren: 0.05 } },
};
const rise = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: SPRING_SOFT },
};

export function Welcome() {
  const recents = useApp((s) => s.recents).slice(0, 6);

  return (
    <div className="welcome">
      <motion.div className="welcome-inner" variants={stagger} initial="hidden" animate="show">
        <motion.div variants={rise} className="welcome-mark" aria-hidden>
          <svg viewBox="0 0 48 48" width="44" height="44">
            <rect x="3" y="3" width="42" height="42" rx="12" fill="var(--raised)" />
            <path d="M15.5 13v22" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" />
            <path d="M21.5 17.5h13M21.5 24h10.5M21.5 30.5h6.5" stroke="var(--text)" strokeWidth="3" strokeLinecap="round" />
            <circle cx="33" cy="30.5" r="2.2" fill="var(--accent)" />
          </svg>
        </motion.div>
        <motion.h1 variants={rise} className="welcome-title">
          Margin
        </motion.h1>
        <motion.p variants={rise} className="welcome-sub">
          Start a note, or open any file. Nothing you type here is lost, saved or not.
        </motion.p>

        <motion.div variants={rise} className="welcome-actions">
          <button type="button" className="welcome-action" onClick={() => runCommand('file.new')}>
            <span className="welcome-action-icon">
              <FilePlus2 size={17} />
            </span>
            <span className="welcome-action-text">New note</span>
            <Keys combo="Ctrl+N" />
          </button>
          <button type="button" className="welcome-action" onClick={() => runCommand('file.open')}>
            <span className="welcome-action-icon">
              <FolderOpen size={17} />
            </span>
            <span className="welcome-action-text">Open file</span>
            <Keys combo="Ctrl+O" />
          </button>
          <button type="button" className="welcome-action" onClick={() => runCommand('app.welcome')}>
            <span className="welcome-action-icon">
              <BookOpen size={17} />
            </span>
            <span className="welcome-action-text">Take the tour</span>
          </button>
        </motion.div>

        {recents.length > 0 && (
          <motion.div variants={rise} className="welcome-recent">
            <p className="welcome-label">Recent</p>
            {recents.map((r) => (
              <button key={r.path} type="button" className="welcome-recent-row" title={r.path} onClick={() => void useApp.getState().openPaths([r.path])}>
                <span className="welcome-recent-name">{r.name}</span>
                <span className="welcome-recent-dir">{dirName(r.path)}</span>
              </button>
            ))}
          </motion.div>
        )}

        <motion.p variants={rise} className="welcome-hint">
          <Upload size={13} /> Press <Keys combo="Ctrl+K" /> for every command
        </motion.p>
      </motion.div>
    </div>
  );
}

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { driver } from 'driver.js';
import type { Config as DriverConfig, DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';
import './tour.css';
import { Button, Modal } from '../components/ui';
import { TourController } from './controller';
import type { TourDriverHandlers } from './controller';
import { TOUR_STEPS, selectorFor } from './steps';
import type { TourStepDef } from './steps';
import { shouldOfferTour, writeTourStatus } from './storage';

/*
 * The product tour, as a feature of the shell.
 *
 * Driver.js supplies the spotlight and popover; everything visible is restyled
 * in tour.css from the design tokens, and the popover's buttons replicate the
 * app's own button recipe, so the tour reads as part of Receipts rather than
 * a library dropped on top. The provider also owns the one-time welcome
 * dialog, which is the app's existing Modal, not a Driver.js artifact.
 */

interface TourContextValue {
  readonly startTour: () => void;
  readonly tourActive: boolean;
}

const TourContext = createContext<TourContextValue | null>(null);

export function useTour(): TourContextValue {
  const value = useContext(TourContext);
  if (value === null) throw new Error('useTour must be used inside TourProvider');
  return value;
}

/** Newest agent linked anywhere in the current page — the directory and the
 *  dashboard both list agents newest-first, so the first match is a sensible
 *  agent to open. Returns null when no agent is on screen. */
function findAgentIdInPage(): string | null {
  const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href^="/agents/"]');
  for (const anchor of Array.from(anchors)) {
    const match = /^\/agents\/([1-9]\d*)$/.exec(anchor.getAttribute('href') ?? '');
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

function toDriveStep(step: TourStepDef): DriveStep {
  const selector = selectorFor(step);
  return {
    // A step without an element renders as a centered dialog, which is what
    // the completion step wants, and also the graceful fallback Driver.js
    // itself applies when a selector matches nothing.
    ...(selector === null ? {} : { element: selector }),
    popover: {
      title: step.title,
      description: step.description,
      ...(step.side === undefined ? {} : { side: step.side }),
      ...(step.align === undefined ? {} : { align: step.align }),
    },
  };
}

function baseDriverConfig(handlers: TourDriverHandlers): DriverConfig {
  return {
    animate: true,
    duration: 250,
    smoothScroll: true,
    allowClose: true,
    // Matches --surface-overlay so the backdrop is the app's own scrim.
    overlayColor: '#060608',
    overlayOpacity: 0.78,
    stagePadding: 8,
    stageRadius: 12, // --radius-lg, so the spotlight matches card corners
    popoverOffset: 12,
    // Cross-page steps: Driver.js waits for the destination element to render
    // before highlighting. Past the timeout the step still shows, centered.
    waitForElement: 5000,
    nextBtnText: 'Next',
    prevBtnText: 'Previous',
    onNextClick: () => handlers.onNext(),
    onPrevClick: () => handlers.onPrev(),
    onDestroyed: (_element, _step, opts) => handlers.onDestroyed(opts.reason),
  };
}

function createTourDriver(handlers: TourDriverHandlers) {
  return driver({
    ...baseDriverConfig(handlers),
    steps: TOUR_STEPS.map(toDriveStep),
    showProgress: true,
    progressText: 'Step {{current}} of {{total}}',
    doneBtnText: 'Explore the application',
    closeBtnLabel: 'Skip tour',
    popoverClass: 'receipts-tour',
    onPopoverRender: (popover, opts) => {
      if (opts.index !== TOUR_STEPS.length - 1) return;
      const restart = document.createElement('button');
      restart.type = 'button';
      restart.textContent = 'Restart tour';
      restart.classList.add('receipts-tour-restart');
      restart.addEventListener('click', () => handlers.onRestart());
      popover.footerButtons.insertBefore(restart, popover.nextButton);
    },
  });
}

/** Welcome dialog body, kept free of portals so it can be unit-tested. */
export function WelcomeDialogContent({
  onStart,
  onDismiss,
}: {
  onStart: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="receipts-tour-welcome">
      <p>
        Receipts helps you understand and verify the reputation of autonomous agents. Let&rsquo;s
        take a quick tour.
      </p>
      <div className="receipts-tour-welcome-actions">
        <Button variant="secondary" size="md" onClick={onDismiss}>
          Maybe later
        </Button>
        <Button variant="primary" size="md" onClick={onStart}>
          Start tour
        </Button>
      </div>
    </div>
  );
}

export function TourProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [tourActive, setTourActive] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);

  // The controller lives for the provider's lifetime; navigation and path are
  // read through refs so its callbacks never go stale.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  const tourControllerRef = useRef<TourController | null>(null);
  tourControllerRef.current ??= new TourController({
    navigate: (path) => navigateRef.current(path),
    currentPath: () => pathRef.current,
    findAgentId: findAgentIdInPage,
    createDriver: createTourDriver,
    persist: writeTourStatus,
    onActiveChange: setTourActive,
  });

  // A route change the controller did not request closes the active tour.
  useEffect(() => {
    tourControllerRef.current?.handleLocationChange(location.pathname);
  }, [location.pathname]);

  // First visit: offer the tour once, after the shell has settled. Returning
  // visitors (completed or dismissed) are never interrupted again, and neither
  // is someone who already launched the tour from the sidebar.
  useEffect(() => {
    if (!shouldOfferTour()) return;
    const timer = setTimeout(() => {
      if (tourControllerRef.current?.isActive() !== true) setWelcomeOpen(true);
    }, 600);
    return () => clearTimeout(timer);
  }, []);

  // The tour starting by any path retires the welcome dialog.
  useEffect(() => {
    if (tourActive) setWelcomeOpen(false);
  }, [tourActive]);

  useEffect(() => {
    const tour = tourControllerRef.current;
    return () => {
      tour?.dispose();
    };
  }, []);

  const startTour = useCallback(() => {
    setWelcomeOpen(false);
    tourControllerRef.current?.start();
  }, []);

  const dismissWelcome = useCallback(() => {
    setWelcomeOpen(false);
    writeTourStatus('dismissed');
  }, []);

  return (
    <TourContext.Provider value={{ startTour, tourActive }}>
      {children}
      <Modal open={welcomeOpen} title="Welcome to Receipts" onClose={dismissWelcome}>
        <WelcomeDialogContent onStart={startTour} onDismiss={dismissWelcome} />
      </Modal>
    </TourContext.Provider>
  );
}

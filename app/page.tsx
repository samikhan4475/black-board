/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import React, { useRef, useEffect, useState } from "react";

interface Coordinates {
  x: number;
  y: number;
}

// Drawing options: stroke color (default white), stroke width, opacity
const STROKE_COLORS = [
  { name: "white", value: "#ffffff" },
  { name: "red", value: "#c0392b" },
  { name: "green", value: "#27ae60" },
  { name: "blue", value: "#2980b9" },
  { name: "orange", value: "#e67e22" },
] as const;
const DEFAULT_BG = "#1a2622";
const STROKE_WIDTHS = [
  { name: "thin", value: 1.5 },
  { name: "medium", value: 3 },
  { name: "thick", value: 6 },
] as const;

const MAX_UNDO = 50;

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const SCRATCH_FILES = [
  "scratch-tap",
  "scratch-start",
  "scratch-slow",
  "scratch-fast",
  "scratch-wave",
] as const;
type ScratchKey = (typeof SCRATCH_FILES)[number];

export default function ChalkboardBliss() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const isDrawingRef = useRef(false);
  const [hasMoved, setHasMoved] = useState<boolean>(false);
  const [imageLoaded, setImageLoaded] = useState<boolean>(false);
  const [audioReady, setAudioReady] = useState<boolean>(false);
  const fillIntervalRef = useRef<number | null>(null);

  // Drawing controls (stroke color, width, opacity)
  const [strokeColor, setStrokeColor] = useState<string>(STROKE_COLORS[0].value); // default white
  const [strokeWidth, setStrokeWidth] = useState<number>(STROKE_WIDTHS[1].value);
  const [opacity, setOpacity] = useState<number>(100);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const undoStackRef = useRef<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const redoStackRef = useRef<string[]>([]);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [toolbarPosition, setToolbarPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const lastAngleRef = useRef<number | null>(null);
  const straightScoreRef = useRef<number>(0);
  const usingStraightRef = useRef<boolean>(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const scratchBuffersRef = useRef<Partial<Record<ScratchKey, AudioBuffer>>>({});
  const scratchWaveSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const scratchWaveGainRef = useRef<GainNode | null>(null);
  const scratchStartedRef = useRef(false);
  const smoothedSpeedRef = useRef(0);
  const tabVisibleRef = useRef(true);
  const hasMovedThisStrokeRef = useRef(false);
  const hasMovedRef = useRef(false);
  const havePlayedStartThisStrokeRef = useRef(false);
  const havePlayedTapThisStrokeRef = useRef(false);
  const leftCanvasThisStrokeRef = useRef(false);

  const lastPosRef = useRef<Coordinates>({ x: 0, y: 0 });
  const lastTimeRef = useRef<number>(0);
  const stillnessTimerRef = useRef<number | null>(null);
  const currentDrawingSessionRef = useRef<number>(0);
  const accumulatedDistanceRef = useRef<number>(0);

  // Load scratch WAVs (scratch-tap, scratch-slow, scratch-fast, etc.)
  useEffect(() => {
    const AudioContext =
      window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioContext();
    audioContextRef.current = ctx;

    const decode = (path: string, label: string) =>
      fetch(path)
        .then((r) => {
          if (!r.ok) {
            console.warn(`[sound] ${label}: fetch failed ${r.status} ${path}`);
            return null;
          }
          return r.arrayBuffer();
        })
        .then((ab) => (ab ? ctx.decodeAudioData(ab) : null))
        .then((buf) => {
          if (buf) console.log(`[sound] loaded: ${label}`);
          return buf;
        })
        .catch((err) => {
          console.warn(`[sound] ${label}:`, err);
          return null;
        });

    console.log("[sound] loading scratch WAVs...");
    Promise.all(
      SCRATCH_FILES.map((key) =>
        decode(`/${key}.wav`, key).then((buf) => ({ key, buf }))
      )
    ).then((results) => {
      const buffers: Partial<Record<ScratchKey, AudioBuffer>> = {};
      results.forEach(({ key, buf }) => {
        if (buf) buffers[key] = buf;
      });
      scratchBuffersRef.current = buffers;
      const loaded = Object.keys(buffers).length;
      console.log(`[sound] ready: ${loaded}/${SCRATCH_FILES.length} files`);
      setAudioReady(true);
    }).catch((err) => {
      console.error("[sound] load failed:", err);
      setAudioReady(true);
    });

    const onVisibilityChange = () => {
      tabVisibleRef.current = document.visibilityState === "visible";
      if (!tabVisibleRef.current) {
        if (scratchStartedRef.current) {
          const src = scratchWaveSourceRef.current;
          if (src) {
            try {
              src.stop();
            } catch (_) {}
            scratchWaveSourceRef.current = null;
          }
          scratchWaveGainRef.current = null;
          scratchStartedRef.current = false;
        }
      }
    };
    tabVisibleRef.current = document.visibilityState === "visible";
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      ctx.close();
      audioContextRef.current = null;
      scratchBuffersRef.current = {};
    };
  }, []);

  const startScratchSound = (): void => {
    if (!tabVisibleRef.current) return;
    if (scratchStartedRef.current) return;
    const ctx = audioContextRef.current;
    const buffers = scratchBuffersRef.current;
    const waveBuf = buffers["scratch-wave"] ?? buffers["scratch-slow"];
    if (!ctx || !waveBuf) return;
    if (ctx.state === "suspended") ctx.resume();

    const startBuf = buffers["scratch-start"];
    if (startBuf && !havePlayedStartThisStrokeRef.current) {
      havePlayedStartThisStrokeRef.current = true;
      const startSrc = ctx.createBufferSource();
      startSrc.buffer = startBuf;
      const startGain = ctx.createGain();
      startGain.gain.value = 0.5;
      startSrc.connect(startGain);
      startGain.connect(ctx.destination);
      startSrc.start(0);
    }

    const waveGain = ctx.createGain();
    waveGain.gain.value = 0;
    waveGain.connect(ctx.destination);

    const waveSource = ctx.createBufferSource();
    waveSource.buffer = waveBuf;
    waveSource.loop = true;
    waveSource.connect(waveGain);
    waveSource.start(0);

    scratchWaveSourceRef.current = waveSource;
    scratchWaveGainRef.current = waveGain;
    scratchStartedRef.current = true;
  };

  const updateScratchSound = (speed: number, _angleDiffRad: number): void => {
    if (!tabVisibleRef.current) return;
    startScratchSound();
    const waveGain = scratchWaveGainRef.current;
    if (!waveGain) return;

    const SMOOTH = 0.35;
    const SPEED_MAX = 4;
    smoothedSpeedRef.current =
      SMOOTH * Math.min(speed, SPEED_MAX) +
      (1 - SMOOTH) * smoothedSpeedRef.current;
    const norm = Math.min(1, smoothedSpeedRef.current / SPEED_MAX);
    const vol = 0.2 + norm * 0.35;
    const t = audioContextRef.current?.currentTime ?? 0;
    waveGain.gain.setTargetAtTime(vol, t, 0.03);
  };

  const stopScratchSound = (): void => {
    if (!scratchStartedRef.current) return;
    const src = scratchWaveSourceRef.current;
    if (src) {
      try {
        src.stop();
      } catch (_) {}
      scratchWaveSourceRef.current = null;
    }
    scratchWaveGainRef.current = null;
    scratchStartedRef.current = false;
    smoothedSpeedRef.current = 0;
  };

  // Initialize canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const img = new Image();
    img.src = "/Bb.jpg.jpeg";
    img.onload = () => {
      bgImageRef.current = img;
      setImageLoaded(true);
      resizeCanvas();
    };
    img.onerror = () => resizeCanvas();

    const drawBg = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      // Draw background color first
      ctx.fillStyle = DEFAULT_BG;
      ctx.fillRect(0, 0, w, h);
      
      if (bgImageRef.current) {
        const img = bgImageRef.current;
        
        // Ensure image dimensions are valid
        if (img.width > 0 && img.height > 0) {
          // Use image smoothing for better quality
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          
          // Both mobile and web: stretch to fill entire canvas
          ctx.drawImage(img, 0, 0, w, h);
        }
      }
    };

    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Draw background at device pixel resolution to avoid pixelation
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawBg(ctx, canvas.width, canvas.height);
      ctx.restore();

      // Scale context for drawing operations
      ctx.scale(dpr, dpr);
    };

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    const ro = new ResizeObserver(() => resizeCanvas());
    ro.observe(canvas);
    return () => {
      window.removeEventListener("resize", resizeCanvas);
      ro.disconnect();
    };
  }, [imageLoaded]);

  // Keep refs in sync for use in handlers
  useEffect(() => {
    undoStackRef.current = undoStack;
  }, [undoStack]);
  useEffect(() => {
    redoStackRef.current = redoStack;
  }, [redoStack]);

  const saveToHistory = (): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const data = canvas.toDataURL("image/png");
    const next = [...undoStackRef.current, data].slice(-MAX_UNDO);
    undoStackRef.current = next;
    setUndoStack(next);
    // Clear redo stack when new action is performed
    redoStackRef.current = [];
    setRedoStack([]);
  };

  const undo = (): void => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    
    // Save current state to redo stack before undoing
    const currentState = canvas.toDataURL("image/png");
    const nextRedo = [...redoStackRef.current, currentState].slice(-MAX_UNDO);
    redoStackRef.current = nextRedo;
    setRedoStack(nextRedo);
    
    const prev = stack[stack.length - 1];
    const img = new Image();
    img.onload = () => {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.restore();
      const next = stack.slice(0, -1);
      undoStackRef.current = next;
      setUndoStack(next);
    };
    img.src = prev;
  };

  const redo = (): void => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    
    // Save current state to undo stack before redoing
    const currentState = canvas.toDataURL("image/png");
    const nextUndo = [...undoStackRef.current, currentState].slice(-MAX_UNDO);
    undoStackRef.current = nextUndo;
    setUndoStack(nextUndo);
    
    const next = stack[stack.length - 1];
    const img = new Image();
    img.onload = () => {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.restore();
      const nextRedo = stack.slice(0, -1);
      redoStackRef.current = nextRedo;
      setRedoStack(nextRedo);
    };
    img.src = next;
  };

  const drawBackground = (ctx: CanvasRenderingContext2D, w: number, h: number): void => {
    // Draw background color first
    ctx.fillStyle = DEFAULT_BG;
    ctx.fillRect(0, 0, w, h);
    
    if (bgImageRef.current) {
      const img = bgImageRef.current;
      
      // Ensure image dimensions are valid
      if (img.width > 0 && img.height > 0) {
        // Use image smoothing for better quality
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        
        // Both mobile and web: stretch to fill entire canvas
        ctx.drawImage(img, 0, 0, w, h);
      }
    }
  };

  const playTapSound = (): void => {
    if (!tabVisibleRef.current) return;
    const ctx = audioContextRef.current;
    const tapBuffer = scratchBuffersRef.current["scratch-tap"];
    if (!ctx || !tapBuffer) return;
    if (ctx.state === "suspended") ctx.resume();

    const source = ctx.createBufferSource();
    source.buffer = tapBuffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.6;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start();
  };

  // Clear the stillness timer (kept for any future use; grains need no stop)
  const clearStillnessTimer = (): void => {
    if (stillnessTimerRef.current) {
      clearTimeout(stillnessTimerRef.current);
      stillnessTimerRef.current = null;
    }
  };

  const resetStillnessTimer = (): void => {
    clearStillnessTimer();
  };

  const isInDrawableArea = (x: number, y: number): boolean => {
    const canvas = canvasRef.current;
    if (!canvas) return false;

    const dpr = window.devicePixelRatio || 1;
    const logicalW = canvas.width / dpr;
    const logicalH = canvas.height / dpr;
    const leftBorder = logicalW * 0.06;
    const rightBorder = logicalW * 0.94;
    const topBorder = logicalH * 0.035;
    const bottomBorder = logicalH * 0.965;

    return (
      x >= leftBorder && x <= rightBorder && y >= topBorder && y <= bottomBorder
    );
  };

  const getCoordinates = (
    e:
      | React.MouseEvent<HTMLCanvasElement>
      | React.TouchEvent<HTMLCanvasElement>,
  ): Coordinates => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const scaleX = canvas.width / dpr / rect.width;
    const scaleY = canvas.height / dpr / rect.height;

    let clientX: number;
    let clientY: number;
    if ("touches" in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;
    return { x, y };
  };

  const startDrawing = (
    e:
      | React.MouseEvent<HTMLCanvasElement>
      | React.TouchEvent<HTMLCanvasElement>,
  ): void => {
    e.preventDefault();

    const { x, y } = getCoordinates(e);
    if (!isInDrawableArea(x, y)) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    // Save current state for undo (before this stroke)
    saveToHistory();

    const now = performance.now();

    // Increment session counter to track unique drawing sessions
    currentDrawingSessionRef.current += 1;

    setIsDrawing(true);
    isDrawingRef.current = true;
    setHasMoved(false);
    hasMovedRef.current = false;
    lastAngleRef.current = null;
    straightScoreRef.current = 0;
    usingStraightRef.current = false;
    lastPosRef.current = { x, y };
    lastTimeRef.current = now;

    const pointerId = (e.nativeEvent as PointerEvent).pointerId;
    if (typeof pointerId === "number" && canvas.setPointerCapture) {
      canvas.setPointerCapture(pointerId);
    }

    hasMovedThisStrokeRef.current = false;
    havePlayedStartThisStrokeRef.current = false;
    havePlayedTapThisStrokeRef.current = false;
    leftCanvasThisStrokeRef.current = false;
    accumulatedDistanceRef.current = 0;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const radiusBuffer = 2 * dpr;
    const cx = x * dpr;
    const cy = y * dpr;

    const alpha = opacity / 100;
    const fillRgba = hexToRgba(strokeColor, alpha * 0.9);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.arc(cx, cy, radiusBuffer, 0, Math.PI * 2);
    ctx.fillStyle = fillRgba;
    ctx.fill();
    ctx.restore();
    // Start stroke path in logical space so draw() lineTo is correct
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const draw = (
    e:
      | React.MouseEvent<HTMLCanvasElement>
      | React.TouchEvent<HTMLCanvasElement>,
  ): void => {
    if (!isDrawingRef.current) return;
    e.preventDefault();

    const { x, y } = getCoordinates(e);

    if (!isInDrawableArea(x, y)) {
      stopDrawing(e as React.PointerEvent<HTMLCanvasElement>, false);
      return;
    }

    hasMovedThisStrokeRef.current = true;

    const timestamp = performance.now();
    const deltaX = x - lastPosRef.current.x;
    const deltaY = y - lastPosRef.current.y;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    if (distance > 0.05) {
      hasMovedRef.current = true;
    }
    const deltaTime = timestamp - lastTimeRef.current || 16;
    const speed = distance / deltaTime;

    if (distance > 2) {
      setHasMoved(true);
      hasMovedRef.current = true;
    }

    if (distance > 4) {
      clearStillnessTimer();

      const angle = Math.atan2(deltaY, deltaX);

      let angleDiffRad = 0;
      if (lastAngleRef.current !== null) {
        const diff = Math.abs(angle - lastAngleRef.current);
        angleDiffRad = Math.min(diff, Math.PI * 2 - diff); // normalize wrap
        if (diff < 0.12) {
          straightScoreRef.current++;
        } else {
          straightScoreRef.current = 0;
        }
      }

      lastAngleRef.current = angle;

      const shouldUseStraight = straightScoreRef.current > 8;
      usingStraightRef.current = shouldUseStraight;

      updateScratchSound(speed, angleDiffRad);
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const alpha = opacity / 100;
      ctx.strokeStyle = hexToRgba(strokeColor, alpha * 0.9);
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineTo(x, y);
      ctx.stroke();

      // Chalk dust particles
      if (distance > 2) {
        const particles = Math.floor(distance / 3);
        const particleSize = 1.2;
        for (let i = 0; i < particles; i++) {
          const t = i / particles;
          const px = lastPosRef.current.x + (x - lastPosRef.current.x) * t;
          const py = lastPosRef.current.y + (y - lastPosRef.current.y) * t;
          const offsetX = (Math.random() - 0.5) * 3;
          const offsetY = (Math.random() - 0.5) * 3;
          ctx.fillStyle = hexToRgba(strokeColor, (Math.random() * 0.3 * alpha));
          ctx.fillRect(px + offsetX, py + offsetY, particleSize, particleSize);
        }
      }

      lastPosRef.current = { x, y };
      lastTimeRef.current = timestamp;

      // Stop scratch after ~80ms of no movement (pointer still down)
      clearStillnessTimer();
      stillnessTimerRef.current = window.setTimeout(() => {
        stopScratchSound();
        stillnessTimerRef.current = null;
      }, 80);
    }
  };

  const stopDrawing = (
    e?: React.PointerEvent<HTMLCanvasElement>,
    playTapOnRelease = true,
  ): void => {
    const canvas = canvasRef.current;
    if (canvas && e?.nativeEvent?.pointerId !== undefined && canvas.releasePointerCapture) {
      try {
        canvas.releasePointerCapture((e.nativeEvent as PointerEvent).pointerId);
      } catch (_) {}
    }
    clearStillnessTimer();
    stopScratchSound();

    if (fillIntervalRef.current) {
      clearInterval(fillIntervalRef.current);
      fillIntervalRef.current = null;
    }

    isDrawingRef.current = false;
    if (isDrawing) {
      setIsDrawing(false);
    }
    // Single tap only: play tap when release is over canvas, didn't move, and didn't leave first
    const pointerStillOverCanvas =
      canvas &&
      e &&
      e.clientX >= canvas.getBoundingClientRect().left &&
      e.clientX <= canvas.getBoundingClientRect().right &&
      e.clientY >= canvas.getBoundingClientRect().top &&
      e.clientY <= canvas.getBoundingClientRect().bottom;
    if (
      playTapOnRelease &&
      !hasMovedThisStrokeRef.current &&
      !leftCanvasThisStrokeRef.current &&
      pointerStillOverCanvas
    ) {
      playTapSound();
    }
    if (!playTapOnRelease) {
      leftCanvasThisStrokeRef.current = true; // so later pointer-up won't play tap
    }
    havePlayedStartThisStrokeRef.current = false;
    lastAngleRef.current = null;
    straightScoreRef.current = 0;
    usingStraightRef.current = false;
  };

  const handleMouseLeave = (): void => {
    clearStillnessTimer();
    stopScratchSound();

    if (fillIntervalRef.current) {
      clearInterval(fillIntervalRef.current);
      fillIntervalRef.current = null;
    }
    setIsDrawing(false);
  };

  const clearCanvas = (): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    saveToHistory();
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Draw background at device pixel resolution to avoid pixelation
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawBackground(ctx, canvas.width, canvas.height);
    ctx.restore();
  };

  const [isMobile, setIsMobile] = useState<boolean>(false);

  // Initialize toolbar position and detect mobile
  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      // Position at top center for both mobile and desktop
      setTimeout(() => {
        const toolbar = toolbarRef.current;
        if (toolbar) {
          const maxX = window.innerWidth - toolbar.offsetWidth - 10; // 10px padding from edge
          const centeredX = Math.max(10, Math.min((window.innerWidth - toolbar.offsetWidth) / 2, maxX));
          setToolbarPosition({
            x: centeredX,
            y: 10, // 10px from top
          });
        } else {
          // Fallback if toolbar not rendered yet
          setToolbarPosition({
            x: Math.max(10, (window.innerWidth - 300) / 2),
            y: 10,
          });
        }
      }, 100);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, [showSettings]);

  useEffect(() => {
    let animationFrameId: number | null = null;

    const handleGlobalPointerMove = (e: PointerEvent) => {
      if (!isDragging) return;
      e.preventDefault();
      
      // Use requestAnimationFrame for smooth dragging
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      
      animationFrameId = requestAnimationFrame(() => {
        const newX = e.clientX - dragOffset.x;
        const newY = e.clientY - dragOffset.y;

        // Constrain to viewport with padding
        const toolbar = toolbarRef.current;
        if (toolbar) {
          const padding = 10;
          const maxX = window.innerWidth - toolbar.offsetWidth - padding;
          const maxY = window.innerHeight - toolbar.offsetHeight - padding;

          setToolbarPosition({
            x: Math.max(padding, Math.min(newX, maxX)),
            y: Math.max(padding, Math.min(newY, maxY)),
          });
        }
      });
    };

    const handleGlobalPointerUp = () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      setIsDragging(false);
    };

    if (isDragging) {
      window.addEventListener("pointermove", handleGlobalPointerMove, { passive: false });
      window.addEventListener("pointerup", handleGlobalPointerUp);
      window.addEventListener("pointercancel", handleGlobalPointerUp);
      return () => {
        if (animationFrameId) {
          cancelAnimationFrame(animationFrameId);
        }
        window.removeEventListener("pointermove", handleGlobalPointerMove);
        window.removeEventListener("pointerup", handleGlobalPointerUp);
        window.removeEventListener("pointercancel", handleGlobalPointerUp);
      };
    }
  }, [isDragging, dragOffset]);

  const handleToolbarDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    // Draggable on all screen sizes
    e.preventDefault();
    setIsDragging(true);
    const rect = toolbarRef.current?.getBoundingClientRect();
    if (rect) {
      setDragOffset({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    }
  };

  const handleToolbarDragEnd = () => {
    setIsDragging(false);
  };
  return (
    <div className="w-full h-screen flex flex-col bg-gray-900 relative overflow-hidden">
      {/* Canvas - full screen */}
      <div className="flex-1 w-full h-full relative">
        <canvas
          ref={canvasRef}
          className="w-full h-full touch-none"
          style={{
            backgroundColor: DEFAULT_BG,
            cursor: "crosshair",
          }}
          onPointerDown={startDrawing}
          onPointerMove={draw}
          onPointerUp={stopDrawing}
          onPointerLeave={(e) => stopDrawing(e, false)}
        />
      </div>

      {/* Unified Toolbar - Draggable on all screens */}
      <div
        ref={toolbarRef}
        className="fixed bg-white rounded-lg md:rounded-xl shadow-2xl p-1.5 md:p-2.5 z-50 cursor-move select-none"
        style={{
          left: `${toolbarPosition.x}px`,
          top: `${toolbarPosition.y}px`,
          transform: "none",
          touchAction: "none",
          willChange: isDragging ? "transform" : "auto",
        }}
        onPointerDown={handleToolbarDragStart}
        onPointerUp={handleToolbarDragEnd}
        onPointerCancel={handleToolbarDragEnd}
      >
        <div className="flex items-center gap-1 md:gap-2">
          {/* Color buttons */}
          <div className="flex gap-0.5 md:gap-1">
            {STROKE_COLORS.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setStrokeColor(c.value);
                }}
                className={`w-5 h-5 md:w-8 md:h-8 rounded border-2 transition-all ${
                  strokeColor === c.value
                    ? "border-blue-500 scale-110 shadow-md"
                    : "border-gray-200 hover:border-gray-300"
                } ${c.value === "#ffffff" ? "border-gray-300" : ""}`}
                style={{ backgroundColor: c.value }}
                title={c.name}
              />
            ))}
          </div>

          {/* Divider */}
          <div className="w-px h-5 md:h-7 bg-gray-200" />

          {/* Settings button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowSettings(!showSettings);
            }}
            className={`w-6 h-6 md:w-10 md:h-10 rounded-md flex items-center justify-center transition-colors ${
              showSettings
                ? "bg-blue-500 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
            title="Settings"
          >
            <svg
              className="w-3.5 h-3.5 md:w-5 md:h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
              />
            </svg>
          </button>

          {/* Undo/Redo buttons */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              undo();
            }}
            disabled={undoStack.length === 0}
            className="w-6 h-6 md:w-10 md:h-10 rounded-md flex items-center justify-center bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Undo"
          >
            <svg
              className="w-3.5 h-3.5 md:w-5 md:h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              redo();
            }}
            disabled={redoStack.length === 0}
            className="w-6 h-6 md:w-10 md:h-10 rounded-md flex items-center justify-center bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Redo"
          >
            <svg
              className="w-3.5 h-3.5 md:w-5 md:h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6"
              />
            </svg>
          </button>
        </div>

        {/* Settings Panel */}
        {showSettings && (
          <div className="mt-2 md:mt-4 pt-2 md:pt-4 border-t border-gray-200 space-y-2 md:space-y-4">
            <div>
              <p className="text-[10px] md:text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1 md:mb-2">
                Stroke width
              </p>
              <div className="flex gap-1.5 md:gap-2">
                {STROKE_WIDTHS.map((w) => (
                  <button
                    key={w.name}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setStrokeWidth(w.value);
                    }}
                    className={`flex-1 flex items-center justify-center rounded-md md:rounded-lg border-2 h-7 md:h-9 transition-all ${
                      strokeWidth === w.value
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                    title={w.name}
                  >
                    <span
                      className="rounded-full bg-gray-700"
                      style={{
                        width: Math.max(2, w.value * 2),
                        height: w.value,
                      }}
                    />
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[10px] md:text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1 md:mb-2">
                Opacity
              </p>
              <input
                type="range"
                min={0}
                max={100}
                value={opacity}
                onChange={(e) => setOpacity(Number(e.target.value))}
                onClick={(e) => e.stopPropagation()}
                className="w-full h-1.5 md:h-2 rounded-full appearance-none bg-gray-200 accent-blue-500"
              />
              <p className="text-[10px] md:text-xs text-gray-500 mt-0.5">{opacity}%</p>
            </div>
            <div className="md:hidden">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  clearCanvas();
                }}
                className="w-full px-2 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-md transition-colors text-xs font-medium"
              >
                Clear Board
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer - hidden on mobile */}
      <div className="hidden md:block bg-gray-800 p-3 text-center text-sm text-gray-400">
        By Ammar Hassan
      </div>
    </div>
  );
}

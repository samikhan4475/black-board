/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import React, { useRef, useEffect, useState } from "react";

interface Coordinates {
  x: number;
  y: number;
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

    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * window.devicePixelRatio;
      canvas.height = rect.height * window.devicePixelRatio;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

      if (bgImageRef.current) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bgImageRef.current, 0, 0, canvas.width, canvas.height);
        ctx.restore();
      } else {
        ctx.fillStyle = "#1a2622";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
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

    const canvas = canvasRef.current;
    if (!canvas) return;

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

    // Draw tap dot in buffer pixel space so size is always 2 CSS pixels (no scale/zoom variance)
    const dpr = window.devicePixelRatio || 1;
    const radiusBuffer = 2 * dpr; // 2 CSS pixels
    const cx = x * dpr;
    const cy = y * dpr;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.arc(cx, cy, radiusBuffer, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
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

      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      ctx.lineTo(x, y);
      ctx.stroke();

      // Chalk dust particles (fixed size so marks look consistent)
      if (distance > 2) {
        const particles = Math.floor(distance / 3);
        const particleSize = 1.2;
        for (let i = 0; i < particles; i++) {
          const t = i / particles;
          const px = lastPosRef.current.x + (x - lastPosRef.current.x) * t;
          const py = lastPosRef.current.y + (y - lastPosRef.current.y) * t;

          const offsetX = (Math.random() - 0.5) * 3;
          const offsetY = (Math.random() - 0.5) * 3;

          ctx.fillStyle = `rgba(255, 255, 255, ${Math.random() * 0.3})`;
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

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (bgImageRef.current) {
      ctx.drawImage(bgImageRef.current, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = "#1a2622";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    ctx.restore();
  };
  return (
    <div className="w-full h-screen flex flex-col bg-gray-900">
      <div className="bg-gray-800 p-4 shadow-lg flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Blackboard</h1>
        <div className="flex items-center gap-4">
          {!audioReady && (
            <span className="text-yellow-400 text-sm">Loading audio...</span>
          )}
          <button
            onClick={clearCanvas}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
          >
            Clear Board
          </button>
        </div>
      </div>

      <div className="flex-1 p-4">
        <canvas
          ref={canvasRef}
          className="w-full h-full rounded-lg shadow-2xl cursor-crosshair touch-none"
          style={{ backgroundColor: "#1a2622" }}
          onPointerDown={startDrawing}
          onPointerMove={draw}
          onPointerUp={stopDrawing}
          onPointerLeave={(e) => stopDrawing(e, false)}
        />
      </div>

      <div className="bg-gray-800 p-3 text-center text-sm text-gray-400">
        By Ammar Hassan
      </div>
    </div>
  );
}

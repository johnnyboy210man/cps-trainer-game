/**
 * CPS TRAINER - Multi-mode Tap Training Game
 * Single-file offline React Native (Expo) app.
 *
 * Modes:
 *  - Classic Countdown (solo): tap descending numbers in order
 *  - CPS Test (solo): mash as fast as possible for a chosen duration
 *  - Reflex Search (solo): tap the called-out number among scattered circles
 *  - Reaction Time (solo): tap the instant the screen turns green
 *  - Classic VS (2 players, split screen): race to finish your countdown first
 *  - CPS VS (2 players, split screen): most clicks in the time limit wins
 *  - Co-op Countdown (2 players, shared screen): clear an extra-large board together
 *
 * Dependencies (see package.json):
 *  expo, react, react-native,
 *  @react-native-async-storage/async-storage,
 *  expo-haptics, expo-av,
 *  react-native-safe-area-context
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Modal,
  ScrollView,
  TextInput,
  Switch,
  StatusBar,
  useWindowDimensions,
  Platform,
  Animated,
  BackHandler,
} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';

/* -------------------------------------------------------------------------- */
/*  CONSTANTS                                                                  */
/* -------------------------------------------------------------------------- */

const STORAGE_SETTINGS_KEY = 'cps_trainer_settings_v2';
const STORAGE_BESTS_KEY = 'cps_trainer_bests_v2';

const START_NUMBER_PRESETS = [20, 30, 50, 75, 100];
const CIRCLE_COUNT_PRESETS = [3, 4, 5, 6, 7];
const CIRCLE_SIZE_PRESETS = [
  { label: 'Small', value: 55 },
  { label: 'Medium', value: 70 },
  { label: 'Large', value: 85 },
];
const CPS_DURATION_PRESETS = [5, 10, 15, 30];
const REFLEX_DURATION_PRESETS = [20, 30, 45, 60];
const REACTION_ROUND_PRESETS = [3, 5, 7, 10];

// Extra clearance (px) beyond the raw safe-area inset, to comfortably clear
// punch-hole cameras / gesture bars on devices like the Galaxy S22 Ultra.
const EDGE_BUFFER = 10;

const THEMES = {
  darkCyber: {
    key: 'darkCyber',
    name: 'Dark Cyber',
    background: '#0a0e17',
    headerBg: '#0d1320',
    surface: '#121a2b',
    circleBg: '#0d1320',
    circleBorder: '#00d4ff',
    circleText: '#00d4ff',
    accent: '#00d4ff',
    textPrimary: '#e6f7ff',
    textSecondary: '#7f93ad',
    success: '#3ddc84',
    danger: '#ff4d6d',
    buttonBg: '#152238',
  },
  neonPink: {
    key: 'neonPink',
    name: 'Neon Pink/Purple',
    background: '#140021',
    headerBg: '#1c0030',
    surface: '#22083a',
    circleBg: '#1c0030',
    circleBorder: '#ff2fd6',
    circleText: '#ff8bf0',
    accent: '#b46bff',
    textPrimary: '#f5e6ff',
    textSecondary: '#a98fce',
    success: '#3ddc84',
    danger: '#ff4d6d',
    buttonBg: '#2a0f45',
  },
  minimalLight: {
    key: 'minimalLight',
    name: 'Minimal Light',
    background: '#f5f5f7',
    headerBg: '#ffffff',
    surface: '#ffffff',
    circleBg: '#ffffff',
    circleBorder: '#007aff',
    circleText: '#1c1c1e',
    accent: '#007aff',
    textPrimary: '#1c1c1e',
    textSecondary: '#6e6e73',
    success: '#28a745',
    danger: '#dc3545',
    buttonBg: '#e9e9ee',
  },
  matrix: {
    key: 'matrix',
    name: 'High-Contrast Matrix',
    background: '#000000',
    headerBg: '#000000',
    surface: '#0a0a0a',
    circleBg: '#000000',
    circleBorder: '#00ff41',
    circleText: '#00ff41',
    accent: '#00ff41',
    textPrimary: '#00ff41',
    textSecondary: '#0aa62f',
    success: '#00ff41',
    danger: '#ff3131',
    buttonBg: '#001a08',
  },
};

const DEFAULT_SETTINGS = {
  startNumber: 50,
  circleCount: 5,
  circleSize: 70,
  themeKey: 'darkCyber',
  hapticsEnabled: true,
  soundEnabled: true,
};

/* -------------------------------------------------------------------------- */
/*  SYNTHESIZED AUDIO (no external asset files - generated PCM WAV at runtime) */
/* -------------------------------------------------------------------------- */

const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function uint8ToBase64(bytes) {
  let result = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < len ? bytes[i + 1] : 0;
    const b3 = i + 2 < len ? bytes[i + 2] : 0;
    const triplet = (b1 << 16) | (b2 << 8) | b3;
    result += BASE64_CHARS[(triplet >> 18) & 0x3f];
    result += BASE64_CHARS[(triplet >> 12) & 0x3f];
    result += i + 1 < len ? BASE64_CHARS[(triplet >> 6) & 0x3f] : '=';
    result += i + 2 < len ? BASE64_CHARS[triplet & 0x3f] : '=';
  }
  return result;
}

function writeAscii(buffer, offset, str) {
  for (let i = 0; i < str.length; i++) {
    buffer[offset + i] = str.charCodeAt(i);
  }
}

function writeUint32LE(buffer, offset, value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
  buffer[offset + 3] = (value >> 24) & 0xff;
}

function writeUint16LE(buffer, offset, value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
}

/**
 * Generates a short 8-bit PCM mono WAV as a data: URI containing a simple
 * synthesized tone (optionally with a second harmonic for a "chime" feel).
 */
function synthesizeToneDataUri({
  frequency = 880,
  durationMs = 120,
  sampleRate = 8000,
  volume = 0.5,
  harmonic = null,
  glide = 0,
}) {
  const numSamples = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataSize = numSamples;
  const totalSize = 44 + dataSize;
  const buffer = new Uint8Array(totalSize);

  writeAscii(buffer, 0, 'RIFF');
  writeUint32LE(buffer, 4, 36 + dataSize);
  writeAscii(buffer, 8, 'WAVE');
  writeAscii(buffer, 12, 'fmt ');
  writeUint32LE(buffer, 16, 16);
  writeUint16LE(buffer, 20, 1);
  writeUint16LE(buffer, 22, 1);
  writeUint32LE(buffer, 24, sampleRate);
  writeUint32LE(buffer, 28, sampleRate);
  writeUint16LE(buffer, 32, 1);
  writeUint16LE(buffer, 34, 8);
  writeAscii(buffer, 36, 'data');
  writeUint32LE(buffer, 40, dataSize);

  const fadeSamples = Math.min(150, Math.floor(numSamples / 4));

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const instFreq = frequency + glide * (i / numSamples);
    let sample = Math.sin(2 * Math.PI * instFreq * t);
    if (harmonic) {
      sample =
        sample * (1 - harmonic.mix) +
        Math.sin(2 * Math.PI * harmonic.freq * t) * harmonic.mix;
    }
    let env = 1;
    if (i < fadeSamples) env = i / fadeSamples;
    else if (i > numSamples - fadeSamples) env = (numSamples - i) / fadeSamples;
    const value = sample * volume * env;
    buffer[44 + i] = Math.max(0, Math.min(255, Math.floor((value + 1) * 127.5)));
  }

  return 'data:audio/wav;base64,' + uint8ToBase64(buffer);
}

const SOUND_URIS = {
  correct: synthesizeToneDataUri({ frequency: 880, durationMs: 70, volume: 0.4 }),
  wrong: synthesizeToneDataUri({ frequency: 160, durationMs: 140, volume: 0.5 }),
  finish: synthesizeToneDataUri({
    frequency: 660,
    durationMs: 420,
    volume: 0.5,
    glide: 220,
    harmonic: { freq: 990, mix: 0.35 },
  }),
};

function useGameSounds(enabled) {
  const soundsRef = useRef({});
  const loadedRef = useRef(false);

  useEffect(() => {
    let isMounted = true;

    async function loadSounds() {
      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
        });
        const entries = await Promise.all(
          Object.entries(SOUND_URIS).map(async ([name, uri]) => {
            const { sound } = await Audio.Sound.createAsync(
              { uri },
              { shouldPlay: false, volume: 1 }
            );
            return [name, sound];
          })
        );
        if (isMounted) {
          const map = {};
          entries.forEach(([name, sound]) => {
            map[name] = sound;
          });
          soundsRef.current = map;
          loadedRef.current = true;
        }
      } catch (e) {
        loadedRef.current = false;
      }
    }

    loadSounds();

    return () => {
      isMounted = false;
      Object.values(soundsRef.current).forEach((s) => {
        try {
          s.unloadAsync();
        } catch (e) {
          // ignore
        }
      });
    };
  }, []);

  const play = useCallback(
    (name) => {
      if (!enabled || !loadedRef.current) return;
      const sound = soundsRef.current[name];
      if (!sound) return;
      sound.replayAsync().catch(() => {});
    },
    [enabled]
  );

  return play;
}

function useHaptics(enabled) {
  return useCallback(
    (type) => {
      if (!enabled) return;
      try {
        if (type === 'success') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } else if (type === 'error') {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        } else if (type === 'finish') {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } catch (e) {
        // Haptics unsupported on this device - ignore.
      }
    },
    [enabled]
  );
}

/* -------------------------------------------------------------------------- */
/*  UTILITIES                                                                  */
/* -------------------------------------------------------------------------- */

function pad2(n) {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const hundredths = Math.floor((total % 1000) / 10);
  return `${pad2(minutes)}:${pad2(seconds)}:${pad2(hundredths)}`;
}

function formatSeconds(ms) {
  return String(Math.max(0, Math.ceil(ms / 1000)));
}

function distance(x1, y1, x2, y2) {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return Math.sqrt(dx * dx + dy * dy);
}

function findNonOverlappingPosition(width, height, diameter, existing, padding = 6) {
  const radius = diameter / 2;
  const minX = radius + padding;
  const maxX = Math.max(minX, width - radius - padding);
  const minY = radius + padding;
  const maxY = Math.max(minY, height - radius - padding);
  const minSeparation = diameter + padding;

  const MAX_ATTEMPTS = 250;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const x = minX + Math.random() * (maxX - minX);
    const y = minY + Math.random() * (maxY - minY);
    const overlaps = existing.some((c) => distance(x, y, c.x, c.y) < minSeparation);
    if (!overlaps) {
      return { x, y };
    }
  }

  const cols = Math.max(1, Math.floor((maxX - minX) / minSeparation) + 1);
  const rows = Math.max(1, Math.floor((maxY - minY) / minSeparation) + 1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = minX + c * minSeparation;
      const y = minY + r * minSeparation;
      const overlaps = existing.some((p) => distance(x, y, p.x, p.y) < minSeparation);
      if (!overlaps) {
        return { x: Math.min(x, maxX), y: Math.min(y, maxY) };
      }
    }
  }

  return {
    x: minX + Math.random() * (maxX - minX),
    y: minY + Math.random() * (maxY - minY),
  };
}

function buildInitialCircles(startNumber, circleCount, width, height, diameter) {
  const highestNumbers = [];
  for (let n = startNumber; n > startNumber - circleCount && n >= 1; n--) {
    highestNumbers.push(n);
  }
  const circles = [];
  highestNumbers.forEach((num) => {
    const pos = findNonOverlappingPosition(width, height, diameter, circles);
    circles.push({ id: `c${num}`, number: num, x: pos.x, y: pos.y });
  });
  return circles;
}

function pickUniqueNumber(existingNumbers, max = 99) {
  if (existingNumbers.length >= max) return existingNumbers[0];
  let n;
  do {
    n = 1 + Math.floor(Math.random() * max);
  } while (existingNumbers.includes(n));
  return n;
}

/* -------------------------------------------------------------------------- */
/*  GAME ENGINE HOOKS (shared by solo / VS / co-op screens)                    */
/* -------------------------------------------------------------------------- */

/**
 * Drives one "descending countdown" board: circles, current target,
 * spawn-on-tap logic, taps/accuracy tracking, and a pausable live timer.
 * Used by Classic Countdown (solo), Co-op Countdown, and each half of
 * Classic VS.
 */
function useClassicGame({ startNumber, circleCount, diameter, playSound, triggerHaptic, onFinish }) {
  const [areaSize, setAreaSize] = useState({ width: 0, height: 0 });
  const [circles, setCircles] = useState([]);
  const [expectedTarget, setExpectedTarget] = useState(startNumber);
  const [totalTaps, setTotalTaps] = useState(0);
  const [correctTaps, setCorrectTaps] = useState(0);
  const [missedTaps, setMissedTaps] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [flashCircleId, setFlashCircleId] = useState(null);

  const nextSpawnRef = useRef(null);
  const startTimeRef = useRef(null);
  const pausedAtRef = useRef(null);
  const pausedTotalRef = useRef(0);
  const intervalRef = useRef(null);
  const initializedRef = useRef(false);
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  const start = useCallback(
    (w, h) => {
      const width = w || areaSize.width;
      const height = h || areaSize.height;
      if (!width || !height) return;
      const initial = buildInitialCircles(startNumber, circleCount, width, height, diameter);
      setCircles(initial);
      setExpectedTarget(startNumber);
      nextSpawnRef.current = startNumber - circleCount;
      setTotalTaps(0);
      setCorrectTaps(0);
      setMissedTaps(0);
      setElapsedMs(0);
      setIsFinished(false);
      setIsPaused(false);
      pausedTotalRef.current = 0;
      pausedAtRef.current = null;
      startTimeRef.current = Date.now();
      setIsRunning(true);
    },
    [startNumber, circleCount, diameter, areaSize]
  );

  const onLayout = useCallback(
    (e) => {
      const { width, height } = e.nativeEvent.layout;
      setAreaSize({ width, height });
      if (!initializedRef.current && width > 0 && height > 0) {
        initializedRef.current = true;
        start(width, height);
      }
    },
    [start]
  );

  useEffect(() => {
    if (isRunning && !isPaused && !isFinished) {
      intervalRef.current = setInterval(() => {
        if (startTimeRef.current != null) {
          setElapsedMs(Date.now() - startTimeRef.current - pausedTotalRef.current);
        }
      }, 30);
    }
    return () => clearInterval(intervalRef.current);
  }, [isRunning, isPaused, isFinished]);

  function finish(finalTotal, finalCorrect, finalMissed) {
    const finalElapsed = Date.now() - startTimeRef.current - pausedTotalRef.current;
    setElapsedMs(finalElapsed);
    setIsRunning(false);
    setIsFinished(true);
    triggerHaptic('finish');
    playSound('finish');
    onFinishRef.current({ timeMs: finalElapsed, totalTaps: finalTotal, correctTaps: finalCorrect, missedTaps: finalMissed });
  }

  const handleTap = useCallback(
    (circle) => {
      if (isFinished || isPaused) return;

      if (circle.number === expectedTarget) {
        triggerHaptic('success');
        playSound('correct');

        const newTotal = totalTaps + 1;
        const newCorrect = correctTaps + 1;
        setTotalTaps(newTotal);
        setCorrectTaps(newCorrect);

        setCircles((prev) => {
          const remaining = prev.filter((c) => c.id !== circle.id);
          let next = remaining;
          if (nextSpawnRef.current !== null && nextSpawnRef.current >= 1) {
            const spawnNum = nextSpawnRef.current;
            nextSpawnRef.current -= 1;
            const pos = findNonOverlappingPosition(areaSize.width, areaSize.height, diameter, remaining);
            next = [...remaining, { id: `c${spawnNum}`, number: spawnNum, x: pos.x, y: pos.y }];
          }
          return next;
        });

        const newExpected = expectedTarget - 1;
        setExpectedTarget(newExpected);

        if (newExpected < 1) {
          finish(newTotal, newCorrect, missedTaps);
        }
      } else {
        triggerHaptic('error');
        playSound('wrong');
        setTotalTaps((t) => t + 1);
        setMissedTaps((m) => m + 1);
        setFlashCircleId(circle.id);
        setTimeout(() => setFlashCircleId((id) => (id === circle.id ? null : id)), 160);
      }
    },
    [expectedTarget, totalTaps, correctTaps, missedTaps, isFinished, isPaused, areaSize, diameter, triggerHaptic, playSound]
  );

  const reset = useCallback(() => start(areaSize.width, areaSize.height), [start, areaSize]);

  const setPaused = useCallback((p) => {
    setIsPaused((prev) => {
      if (p === prev) return prev;
      if (p) {
        pausedAtRef.current = Date.now();
      } else if (pausedAtRef.current != null) {
        pausedTotalRef.current += Date.now() - pausedAtRef.current;
        pausedAtRef.current = null;
      }
      return p;
    });
  }, []);

  return {
    onLayout,
    circles,
    expectedTarget,
    elapsedMs,
    totalTaps,
    correctTaps,
    missedTaps,
    isRunning,
    isFinished,
    isPaused,
    flashCircleId,
    handleTap,
    reset,
    setPaused,
    areaSize,
  };
}

/**
 * Drives a fixed-duration "tap as fast as you can" test. Used by the CPS
 * Test solo screen and each half of CPS VS.
 */
function useCpsGame({ durationSec, playSound, triggerHaptic, onFinish }) {
  const [totalTaps, setTotalTaps] = useState(0);
  const [remainingMs, setRemainingMs] = useState(durationSec * 1000);
  const [isRunning, setIsRunning] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const tapTimestampsRef = useRef([]);
  const startTimeRef = useRef(null);
  const pausedAtRef = useRef(null);
  const pausedTotalRef = useRef(0);
  const intervalRef = useRef(null);
  const initializedRef = useRef(false);
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  const start = useCallback(() => {
    tapTimestampsRef.current = [];
    setTotalTaps(0);
    setRemainingMs(durationSec * 1000);
    setIsFinished(false);
    setIsPaused(false);
    pausedTotalRef.current = 0;
    pausedAtRef.current = null;
    startTimeRef.current = Date.now();
    setIsRunning(true);
  }, [durationSec]);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      start();
    }
  }, [start]);

  function finish() {
    setIsRunning(false);
    setIsFinished(true);
    const taps = tapTimestampsRef.current;
    const totalTapsFinal = taps.length;
    const cps = totalTapsFinal / durationSec;
    const intervals = [];
    for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
    const avgIntervalMs = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
    const fastestIntervalMs = intervals.length ? Math.min(...intervals) : 0;
    let bestWindow = 0;
    for (let i = 0; i < taps.length; i++) {
      let count = 1;
      for (let j = i + 1; j < taps.length && taps[j] - taps[i] < 1000; j++) count++;
      if (count > bestWindow) bestWindow = count;
    }
    triggerHaptic('finish');
    playSound('finish');
    onFinishRef.current({ totalTaps: totalTapsFinal, cps, avgIntervalMs, fastestIntervalMs, bestWindow });
  }

  useEffect(() => {
    if (isRunning && !isPaused && !isFinished) {
      intervalRef.current = setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current - pausedTotalRef.current;
        const remaining = durationSec * 1000 - elapsed;
        if (remaining <= 0) {
          setRemainingMs(0);
          finish();
        } else {
          setRemainingMs(remaining);
        }
      }, 30);
    }
    return () => clearInterval(intervalRef.current);
  }, [isRunning, isPaused, isFinished]);

  const handleTap = useCallback(() => {
    if (isFinished || isPaused || !isRunning) return;
    tapTimestampsRef.current.push(Date.now());
    setTotalTaps((t) => t + 1);
    triggerHaptic('success');
    playSound('correct');
  }, [isFinished, isPaused, isRunning, triggerHaptic, playSound]);

  const reset = useCallback(() => start(), [start]);

  const setPaused = useCallback((p) => {
    setIsPaused((prev) => {
      if (p === prev) return prev;
      if (p) {
        pausedAtRef.current = Date.now();
      } else if (pausedAtRef.current != null) {
        pausedTotalRef.current += Date.now() - pausedAtRef.current;
        pausedAtRef.current = null;
      }
      return p;
    });
  }, []);

  return { totalTaps, remainingMs, isRunning, isFinished, isPaused, handleTap, reset, setPaused };
}

/* -------------------------------------------------------------------------- */
/*  REUSABLE UI PIECES                                                        */
/* -------------------------------------------------------------------------- */

function PrimaryButton({ label, onPress, theme, style, textStyle, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.primaryButton,
        { backgroundColor: theme.accent, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      <Text style={[styles.primaryButtonText, textStyle]}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({ label, onPress, theme, style, textStyle, active }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.secondaryButton,
        {
          backgroundColor: theme.buttonBg,
          borderColor: active ? theme.accent : 'transparent',
          opacity: pressed ? 0.75 : 1,
        },
        style,
      ]}
    >
      <Text
        style={[
          styles.secondaryButtonText,
          { color: active ? theme.accent : theme.textPrimary },
          textStyle,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SectionLabel({ children, theme }) {
  return <Text style={[styles.sectionLabel, { color: theme.textSecondary }]}>{children}</Text>;
}

function ModeCard({ theme, title, description, children, onPlay, footnote }) {
  return (
    <View style={[styles.modeCard, { backgroundColor: theme.surface, borderColor: theme.buttonBg }]}>
      <Text style={[styles.modeCardTitle, { color: theme.textPrimary }]}>{title}</Text>
      <Text style={[styles.modeCardDesc, { color: theme.textSecondary }]}>{description}</Text>
      {children}
      {footnote ? (
        <Text style={[styles.modeCardFootnote, { color: theme.textSecondary }]}>{footnote}</Text>
      ) : null}
      <PrimaryButton label="PLAY" theme={theme} onPress={onPlay} style={{ marginTop: 14 }} />
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/*  MAIN MENU SCREEN                                                          */
/* -------------------------------------------------------------------------- */

function MainMenuScreen({ theme, settings, bests, onStart, onOpenSettings }) {
  const key = `classic_${settings.startNumber}_${settings.circleCount}`;
  const best = bests[key];

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.background }]}>
      <View style={styles.menuContainer}>
        <Text style={[styles.title, { color: theme.accent }]}>CPS TRAINER</Text>
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
          Tap. Descend. Improve your speed.
        </Text>

        <View style={styles.menuButtonGroup}>
          <PrimaryButton label="PLAY" onPress={onStart} theme={theme} />
          <SecondaryButton
            label="SETTINGS"
            onPress={onOpenSettings}
            theme={theme}
            style={{ marginTop: 14 }}
          />
        </View>

        <View style={[styles.bestCard, { backgroundColor: theme.surface, borderColor: theme.buttonBg }]}>
          <Text style={[styles.bestCardTitle, { color: theme.textPrimary }]}>
            Personal Best · Classic {settings.startNumber}/{settings.circleCount}
          </Text>
          {best ? (
            <View style={styles.bestStatsRow}>
              <BestStat label="Time" value={formatTime(best.timeMs)} theme={theme} />
              <BestStat label="CPS" value={best.cps.toFixed(2)} theme={theme} />
              <BestStat label="Acc" value={`${best.accuracy.toFixed(1)}%`} theme={theme} />
            </View>
          ) : (
            <Text style={{ color: theme.textSecondary, marginTop: 8 }}>
              No record yet - be the first!
            </Text>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

function BestStat({ label, value, theme }) {
  return (
    <View style={styles.bestStat}>
      <Text style={[styles.bestStatValue, { color: theme.accent }]}>{value}</Text>
      <Text style={[styles.bestStatLabel, { color: theme.textSecondary }]}>{label}</Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/*  MODE SELECT SCREEN                                                       */
/* -------------------------------------------------------------------------- */

function ChipPicker({ theme, options, value, onChange, suffix = '' }) {
  return (
    <View style={styles.chipRow}>
      {options.map((n) => (
        <SecondaryButton
          key={n}
          label={`${n}${suffix}`}
          theme={theme}
          active={value === n}
          onPress={() => onChange(n)}
          style={styles.chip}
        />
      ))}
    </View>
  );
}

function ModeSelectScreen({ theme, settings, onBack, onPlay }) {
  const [cpsDuration, setCpsDuration] = useState(10);
  const [cpsVsDuration, setCpsVsDuration] = useState(10);
  const [reflexDuration, setReflexDuration] = useState(30);
  const [reactionRounds, setReactionRounds] = useState(5);

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.background }]}>
      <View style={[styles.settingsHeader, { borderBottomColor: theme.buttonBg }]}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={[styles.backArrow, { color: theme.accent }]}>{'‹ Back'}</Text>
        </Pressable>
        <Text style={[styles.settingsTitle, { color: theme.textPrimary }]}>Game Modes</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView contentContainerStyle={styles.settingsScroll}>
        <SectionLabel theme={theme}>SOLO</SectionLabel>

        <ModeCard
          theme={theme}
          title="Classic Countdown"
          description={`Tap descending numbers in order, from ${settings.startNumber} down to 1.`}
          footnote={`Uses your Settings: start ${settings.startNumber}, ${settings.circleCount} circles on screen.`}
          onPlay={() => onPlay('classic', {})}
        />

        <ModeCard
          theme={theme}
          title="CPS Test"
          description="Tap as fast as you can for a fixed time. See your clicks-per-second and more."
          onPlay={() => onPlay('cps', { durationSec: cpsDuration })}
        >
          <ChipPicker theme={theme} options={CPS_DURATION_PRESETS} value={cpsDuration} onChange={setCpsDuration} suffix="s" />
        </ModeCard>

        <ModeCard
          theme={theme}
          title="Reflex Search"
          description="A target number is called out - find and tap the matching circle among the scattered numbers, as many times as you can."
          onPlay={() => onPlay('random', { durationSec: reflexDuration })}
        >
          <ChipPicker theme={theme} options={REFLEX_DURATION_PRESETS} value={reflexDuration} onChange={setReflexDuration} suffix="s" />
        </ModeCard>

        <ModeCard
          theme={theme}
          title="Reaction Time"
          description="Wait for the screen to turn green, then tap as fast as you can. Measures your raw reaction speed."
          onPlay={() => onPlay('reaction', { rounds: reactionRounds })}
        >
          <ChipPicker theme={theme} options={REACTION_ROUND_PRESETS} value={reactionRounds} onChange={setReactionRounds} suffix=" rounds" />
        </ModeCard>

        <SectionLabel theme={theme}>VERSUS · 2 PLAYERS, SPLIT SCREEN</SectionLabel>

        <ModeCard
          theme={theme}
          title="Classic VS"
          description="Split screen, each player gets their own countdown board. First to finish their sequence wins."
          footnote={`Uses your Settings: start ${settings.startNumber}, ${settings.circleCount} circles on screen.`}
          onPlay={() => onPlay('classicVs', {})}
        />

        <ModeCard
          theme={theme}
          title="CPS VS"
          description="Split screen, both players mash for the same time limit. Most taps when time's up wins."
          onPlay={() => onPlay('cpsVs', { durationSec: cpsVsDuration })}
        >
          <ChipPicker theme={theme} options={CPS_DURATION_PRESETS} value={cpsVsDuration} onChange={setCpsVsDuration} suffix="s" />
        </ModeCard>

        <SectionLabel theme={theme}>CO-OP · 2 PLAYERS, SHARED SCREEN</SectionLabel>

        <ModeCard
          theme={theme}
          title="Co-op Countdown"
          description="One shared board with extra circles on screen at once. Both players tap the same sequence together - clear it as a team, as fast as you can."
          footnote={`Circles on screen: ${settings.circleCount + 2} (2 more than your Settings, to keep both players busy).`}
          onPlay={() => onPlay('coop', {})}
        />

        <Text style={[styles.moreModesNote, { color: theme.textSecondary }]}>
          More modes (and VS versions of Reflex Search / Reaction Time) are on the
          way - let me know which you'd like next.
        </Text>

        <View style={{ height: 30 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

/* -------------------------------------------------------------------------- */
/*  SETTINGS SCREEN                                                           */
/* -------------------------------------------------------------------------- */

function SettingsScreen({ theme, settings, onChange, onBack }) {
  const [customStart, setCustomStart] = useState(String(settings.startNumber));
  const [customSize, setCustomSize] = useState(String(settings.circleSize));

  const isStartPreset = START_NUMBER_PRESETS.includes(settings.startNumber);
  const isSizePreset = CIRCLE_SIZE_PRESETS.some((p) => p.value === settings.circleSize);

  function applyCustomStart() {
    const n = parseInt(customStart, 10);
    if (!Number.isNaN(n) && n >= 2 && n <= 999) {
      onChange({ startNumber: n });
    }
  }

  function applyCustomSize() {
    const n = parseInt(customSize, 10);
    if (!Number.isNaN(n) && n >= 40 && n <= 140) {
      onChange({ circleSize: n });
    }
  }

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.background }]}>
      <View style={[styles.settingsHeader, { borderBottomColor: theme.buttonBg }]}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={[styles.backArrow, { color: theme.accent }]}>{'‹ Back'}</Text>
        </Pressable>
        <Text style={[styles.settingsTitle, { color: theme.textPrimary }]}>Settings</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView contentContainerStyle={styles.settingsScroll}>
        <SectionLabel theme={theme}>STARTING NUMBER</SectionLabel>
        <View style={styles.chipRow}>
          {START_NUMBER_PRESETS.map((n) => (
            <SecondaryButton
              key={n}
              label={String(n)}
              theme={theme}
              active={settings.startNumber === n}
              onPress={() => {
                onChange({ startNumber: n });
                setCustomStart(String(n));
              }}
              style={styles.chip}
            />
          ))}
        </View>
        <View style={styles.customRow}>
          <Text style={{ color: theme.textSecondary }}>Custom:</Text>
          <TextInput
            value={customStart}
            onChangeText={setCustomStart}
            onEndEditing={applyCustomStart}
            onBlur={applyCustomStart}
            keyboardType="number-pad"
            style={[
              styles.textInput,
              {
                color: theme.textPrimary,
                borderColor: !isStartPreset ? theme.accent : theme.buttonBg,
                backgroundColor: theme.surface,
              },
            ]}
            maxLength={3}
          />
        </View>

        <SectionLabel theme={theme}>CIRCLES ON SCREEN</SectionLabel>
        <View style={styles.chipRow}>
          {CIRCLE_COUNT_PRESETS.map((n) => (
            <SecondaryButton
              key={n}
              label={String(n)}
              theme={theme}
              active={settings.circleCount === n}
              onPress={() => onChange({ circleCount: n })}
              style={styles.chip}
            />
          ))}
        </View>

        <SectionLabel theme={theme}>CIRCLE SIZE</SectionLabel>
        <View style={styles.chipRow}>
          {CIRCLE_SIZE_PRESETS.map((p) => (
            <SecondaryButton
              key={p.label}
              label={`${p.label} (${p.value})`}
              theme={theme}
              active={settings.circleSize === p.value}
              onPress={() => {
                onChange({ circleSize: p.value });
                setCustomSize(String(p.value));
              }}
              style={styles.chip}
            />
          ))}
        </View>
        <View style={styles.customRow}>
          <Text style={{ color: theme.textSecondary }}>Custom (40-140px):</Text>
          <TextInput
            value={customSize}
            onChangeText={setCustomSize}
            onEndEditing={applyCustomSize}
            onBlur={applyCustomSize}
            keyboardType="number-pad"
            style={[
              styles.textInput,
              {
                color: theme.textPrimary,
                borderColor: !isSizePreset ? theme.accent : theme.buttonBg,
                backgroundColor: theme.surface,
              },
            ]}
            maxLength={3}
          />
        </View>

        <SectionLabel theme={theme}>COLOR THEME</SectionLabel>
        <View style={styles.themeGrid}>
          {Object.values(THEMES).map((t) => (
            <Pressable
              key={t.key}
              onPress={() => onChange({ themeKey: t.key })}
              style={[
                styles.themeCard,
                {
                  backgroundColor: t.background,
                  borderColor: settings.themeKey === t.key ? theme.accent : 'transparent',
                },
              ]}
            >
              <View
                style={[
                  styles.themeSwatch,
                  { backgroundColor: t.circleBg, borderColor: t.circleBorder },
                ]}
              />
              <Text style={[styles.themeCardLabel, { color: t.textPrimary }]}>{t.name}</Text>
            </Pressable>
          ))}
        </View>

        <SectionLabel theme={theme}>FEEDBACK</SectionLabel>
        <View style={[styles.switchRow, { borderColor: theme.buttonBg }]}>
          <Text style={{ color: theme.textPrimary, fontSize: 15 }}>Haptic Feedback</Text>
          <Switch
            value={settings.hapticsEnabled}
            onValueChange={(v) => onChange({ hapticsEnabled: v })}
            trackColor={{ true: theme.accent }}
          />
        </View>
        <View style={[styles.switchRow, { borderColor: theme.buttonBg }]}>
          <Text style={{ color: theme.textPrimary, fontSize: 15 }}>Sound Effects</Text>
          <Switch
            value={settings.soundEnabled}
            onValueChange={(v) => onChange({ soundEnabled: v })}
            trackColor={{ true: theme.accent }}
          />
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

/* -------------------------------------------------------------------------- */
/*  CLASSIC COUNTDOWN - SOLO (also used for Co-op, with a bigger circle count) */
/* -------------------------------------------------------------------------- */

function ClassicSoloScreen({ theme, settings, bests, onExit, onRecordResult, circleCountOverride, bestsPrefix = 'classic', headerLabel }) {
  const insets = useSafeAreaInsets();
  const circleCount = circleCountOverride || settings.circleCount;
  const diameter = settings.circleSize;
  const playSound = useGameSounds(settings.soundEnabled);
  const triggerHaptic = useHaptics(settings.hapticsEnabled);
  const [result, setResult] = useState(null);

  const bestsKey = `${bestsPrefix}_${settings.startNumber}_${circleCount}`;

  const handleFinish = useCallback(
    (raw) => {
      const seconds = Math.max(raw.timeMs / 1000, 0.01);
      const accuracy = raw.totalTaps > 0 ? (raw.correctTaps / raw.totalTaps) * 100 : 100;
      const cps = raw.totalTaps / seconds;
      const prevBest = bests[bestsKey];
      const isNewBest = !prevBest || raw.timeMs < prevBest.timeMs;
      const summary = { timeMs: raw.timeMs, accuracy, cps, missed: raw.missedTaps, isNewBest };
      setResult(summary);
      if (isNewBest) {
        onRecordResult(bestsKey, { timeMs: raw.timeMs, accuracy, cps, date: Date.now() });
      }
    },
    [bests, bestsKey, onRecordResult]
  );

  const game = useClassicGame({
    startNumber: settings.startNumber,
    circleCount,
    diameter,
    playSound,
    triggerHaptic,
    onFinish: handleFinish,
  });

  function handleReset() {
    setResult(null);
    game.reset();
  }

  const accuracyLive = game.totalTaps > 0 ? (game.correctTaps / game.totalTaps) * 100 : 100;
  const cpsLive = game.elapsedMs > 0 ? game.totalTaps / (game.elapsedMs / 1000) : 0;

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.background }]} edges={['left', 'right']}>
      <StatusBar barStyle={theme.key === 'minimalLight' ? 'dark-content' : 'light-content'} />

      <View style={[styles.hud, { backgroundColor: theme.headerBg, borderBottomColor: theme.buttonBg, paddingTop: insets.top + EDGE_BUFFER }]}>
        <View style={styles.hudLeft}>
          <Text style={[styles.hudTargetLabel, { color: theme.textSecondary }]}>{headerLabel || 'TARGET'}</Text>
          <Text style={[styles.hudTargetValue, { color: theme.accent }]}>
            {game.expectedTarget >= 1 ? game.expectedTarget : '-'}
          </Text>
        </View>

        <View style={styles.hudCenter}>
          <Text style={[styles.hudTimer, { color: theme.textPrimary }]}>{formatTime(game.elapsedMs)}</Text>
          <Text style={[styles.hudSubStats, { color: theme.textSecondary }]}>
            CPS {cpsLive.toFixed(1)} · Acc {accuracyLive.toFixed(0)}%
          </Text>
        </View>

        <View style={styles.hudRight}>
          <Pressable onPress={handleReset} style={styles.hudIconButton} hitSlop={10}>
            <Text style={[styles.hudIconText, { color: theme.textPrimary }]}>⟲</Text>
          </Pressable>
          <Pressable onPress={() => game.setPaused(true)} style={styles.hudIconButton} hitSlop={10}>
            <Text style={[styles.hudIconText, { color: theme.textPrimary }]}>☰</Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.playArea, { paddingBottom: insets.bottom + EDGE_BUFFER }]} onLayout={game.onLayout}>
        {game.circles.map((circle) => {
          const isFlashing = game.flashCircleId === circle.id;
          return (
            <Pressable
              key={circle.id}
              onPress={() => game.handleTap(circle)}
              style={[
                styles.circle,
                {
                  width: diameter,
                  height: diameter,
                  borderRadius: diameter / 2,
                  left: circle.x - diameter / 2,
                  top: circle.y - diameter / 2,
                  backgroundColor: isFlashing ? theme.danger : theme.circleBg,
                  borderColor: isFlashing ? theme.danger : theme.circleBorder,
                },
              ]}
              hitSlop={4}
            >
              <Text
                style={[
                  styles.circleText,
                  { color: isFlashing ? '#ffffff' : theme.circleText, fontSize: Math.max(14, diameter * 0.32) },
                ]}
              >
                {circle.number}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Modal visible={game.isPaused && !game.isFinished} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.pauseCard, { backgroundColor: theme.surface }]}>
            <Text style={[styles.pauseTitle, { color: theme.textPrimary }]}>Paused</Text>
            <PrimaryButton label="RESUME" theme={theme} onPress={() => game.setPaused(false)} style={{ marginTop: 18 }} />
            <SecondaryButton
              label="RESTART RUN"
              theme={theme}
              onPress={() => {
                game.setPaused(false);
                handleReset();
              }}
              style={{ marginTop: 12 }}
            />
            <SecondaryButton label="MODE SELECT" theme={theme} onPress={onExit} style={{ marginTop: 12 }} />
          </View>
        </View>
      </Modal>

      <Modal visible={game.isFinished && !!result} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.victoryCard, { backgroundColor: theme.surface }]}>
            {result?.isNewBest ? (
              <View style={[styles.badge, { backgroundColor: theme.accent }]}>
                <Text style={styles.badgeText}>NEW HIGH SCORE!</Text>
              </View>
            ) : null}
            <Text style={[styles.victoryTitle, { color: theme.textPrimary }]}>Run Complete</Text>

            <View style={styles.victoryStatsGrid}>
              <VictoryStat label="Total Time" value={result ? formatTime(result.timeMs) : '--'} theme={theme} />
              <VictoryStat label="Accuracy" value={result ? `${result.accuracy.toFixed(1)}%` : '--'} theme={theme} />
              <VictoryStat label="CPS" value={result ? result.cps.toFixed(2) : '--'} theme={theme} />
              <VictoryStat label="Missed" value={result ? String(result.missed) : '--'} theme={theme} />
            </View>

            <PrimaryButton label="PLAY AGAIN" theme={theme} onPress={handleReset} style={{ marginTop: 22 }} />
            <SecondaryButton label="MODE SELECT" theme={theme} onPress={onExit} style={{ marginTop: 12 }} />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function VictoryStat({ label, value, theme }) {
  return (
    <View style={styles.victoryStat}>
      <Text style={[styles.victoryStatValue, { color: theme.accent }]}>{value}</Text>
      <Text style={[styles.victoryStatLabel, { color: theme.textSecondary }]}>{label}</Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/*  CPS TEST - SOLO                                                           */
/* -------------------------------------------------------------------------- */

function CpsSoloScreen({ theme, settings, durationSec, bests, onExit, onRecordResult }) {
  const insets = useSafeAreaInsets();
  const playSound = useGameSounds(settings.soundEnabled);
  const triggerHaptic = useHaptics(settings.hapticsEnabled);
  const [result, setResult] = useState(null);
  const bestsKey = `cps_${durationSec}`;

  const handleFinish = useCallback(
    (stats) => {
      const prevBest = bests[bestsKey];
      const isNewBest = !prevBest || stats.cps > prevBest.cps;
      const summary = { ...stats, isNewBest };
      setResult(summary);
      if (isNewBest) {
        onRecordResult(bestsKey, { cps: stats.cps, totalTaps: stats.totalTaps, date: Date.now() });
      }
    },
    [bests, bestsKey, onRecordResult]
  );

  const game = useCpsGame({ durationSec, playSound, triggerHaptic, onFinish: handleFinish });

  function handleReset() {
    setResult(null);
    game.reset();
  }

  const liveCps = durationSec > 0 ? game.totalTaps / durationSec : 0;

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.background }]} edges={['left', 'right']}>
      <StatusBar barStyle={theme.key === 'minimalLight' ? 'dark-content' : 'light-content'} />

      <View style={[styles.hud, { backgroundColor: theme.headerBg, borderBottomColor: theme.buttonBg, paddingTop: insets.top + EDGE_BUFFER }]}>
        <View style={styles.hudLeft}>
          <Text style={[styles.hudTargetLabel, { color: theme.textSecondary }]}>TIME LEFT</Text>
          <Text style={[styles.hudTargetValue, { color: theme.accent }]}>{formatSeconds(game.remainingMs)}</Text>
        </View>
        <View style={styles.hudCenter}>
          <Text style={[styles.hudTimer, { color: theme.textPrimary }]}>{game.totalTaps} taps</Text>
          <Text style={[styles.hudSubStats, { color: theme.textSecondary }]}>CPS {liveCps.toFixed(1)}</Text>
        </View>
        <View style={styles.hudRight}>
          <Pressable onPress={handleReset} style={styles.hudIconButton} hitSlop={10}>
            <Text style={[styles.hudIconText, { color: theme.textPrimary }]}>⟲</Text>
          </Pressable>
          <Pressable onPress={onExit} style={styles.hudIconButton} hitSlop={10}>
            <Text style={[styles.hudIconText, { color: theme.textPrimary }]}>☰</Text>
          </Pressable>
        </View>
      </View>

      <Pressable
        style={[styles.tapZone, { backgroundColor: theme.background, paddingBottom: insets.bottom + EDGE_BUFFER }]}
        onPress={game.handleTap}
      >
        <View style={[styles.tapZoneCircle, { borderColor: theme.circleBorder, backgroundColor: theme.circleBg }]}>
          <Text style={[styles.tapZoneNumber, { color: theme.circleText }]}>{game.totalTaps}</Text>
          <Text style={[styles.tapZoneHint, { color: theme.textSecondary }]}>TAP HERE</Text>
        </View>
      </Pressable>

      <Modal visible={game.isFinished && !!result} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.victoryCard, { backgroundColor: theme.surface }]}>
            {result?.isNewBest ? (
              <View style={[styles.badge, { backgroundColor: theme.accent }]}>
                <Text style={styles.badgeText}>NEW HIGH SCORE!</Text>
              </View>
            ) : null}
            <Text style={[styles.victoryTitle, { color: theme.textPrimary }]}>Time's Up</Text>
            <View style={styles.victoryStatsGrid}>
              <VictoryStat label="Total Taps" value={result ? String(result.totalTaps) : '--'} theme={theme} />
              <VictoryStat label="CPS" value={result ? result.cps.toFixed(2) : '--'} theme={theme} />
              <VictoryStat label="Avg Interval" value={result ? `${result.avgIntervalMs.toFixed(0)}ms` : '--'} theme={theme} />
              <VictoryStat label="Fastest Gap" value={result ? `${result.fastestIntervalMs.toFixed(0)}ms` : '--'} theme={theme} />
              <VictoryStat label="Best 1s Burst" value={result ? String(result.bestWindow) : '--'} theme={theme} />
            </View>
            <PrimaryButton label="TRY AGAIN" theme={theme} onPress={handleReset} style={{ marginTop: 22 }} />
            <SecondaryButton label="MODE SELECT" theme={theme} onPress={onExit} style={{ marginTop: 12 }} />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/* -------------------------------------------------------------------------- */
/*  REFLEX SEARCH - SOLO                                                     */
/* -------------------------------------------------------------------------- */

function RandomTargetScreen({ theme, settings, durationSec, bests, onExit, onRecordResult }) {
  const insets = useSafeAreaInsets();
  const diameter = settings.circleSize;
  const circleCount = settings.circleCount;
  const playSound = useGameSounds(settings.soundEnabled);
  const triggerHaptic = useHaptics(settings.hapticsEnabled);

  const [areaSize, setAreaSize] = useState({ width: 0, height: 0 });
  const [circles, setCircles] = useState([]);
  const [target, setTarget] = useState(null);
  const [correctTaps, setCorrectTaps] = useState(0);
  const [totalTaps, setTotalTaps] = useState(0);
  const [remainingMs, setRemainingMs] = useState(durationSec * 1000);
  const [isRunning, setIsRunning] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [flashCircleId, setFlashCircleId] = useState(null);
  const [result, setResult] = useState(null);

  const startTimeRef = useRef(null);
  const intervalRef = useRef(null);
  const initializedRef = useRef(null);
  const bestsKey = `reflex_${durationSec}`;

  const buildBoard = useCallback(
    (w, h) => {
      const nums = [];
      const list = [];
      for (let i = 0; i < circleCount; i++) {
        const n = pickUniqueNumber(nums);
        nums.push(n);
        const pos = findNonOverlappingPosition(w, h, diameter, list);
        list.push({ id: `r${n}_${i}`, number: n, x: pos.x, y: pos.y });
      }
      return list;
    },
    [circleCount, diameter]
  );

  const start = useCallback(
    (w, h) => {
      const width = w || areaSize.width;
      const height = h || areaSize.height;
      if (!width || !height) return;
      const board = buildBoard(width, height);
      setCircles(board);
      setTarget(board[Math.floor(Math.random() * board.length)].number);
      setCorrectTaps(0);
      setTotalTaps(0);
      setRemainingMs(durationSec * 1000);
      setIsFinished(false);
      setResult(null);
      startTimeRef.current = Date.now();
      setIsRunning(true);
    },
    [areaSize, buildBoard, durationSec]
  );

  const handleLayout = useCallback(
    (e) => {
      const { width, height } = e.nativeEvent.layout;
      setAreaSize({ width, height });
      if (!initializedRef.current && width > 0 && height > 0) {
        initializedRef.current = true;
        start(width, height);
      }
    },
    [start]
  );

  useEffect(() => {
    if (isRunning && !isFinished) {
      intervalRef.current = setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        const remaining = durationSec * 1000 - elapsed;
        if (remaining <= 0) {
          setRemainingMs(0);
          finishRun();
        } else {
          setRemainingMs(remaining);
        }
      }, 30);
    }
    return () => clearInterval(intervalRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, isFinished]);

  function finishRun() {
    setIsRunning(false);
    setIsFinished(true);
    setCorrectTaps((finalCorrect) => {
      setTotalTaps((finalTotal) => {
        const accuracy = finalTotal > 0 ? (finalCorrect / finalTotal) * 100 : 100;
        const cps = finalCorrect / durationSec;
        const prevBest = bests[bestsKey];
        const isNewBest = !prevBest || finalCorrect > prevBest.correctTaps;
        const summary = { correctTaps: finalCorrect, totalTaps: finalTotal, accuracy, cps, isNewBest };
        setResult(summary);
        triggerHaptic('finish');
        playSound('finish');
        if (isNewBest) {
          onRecordResult(bestsKey, { correctTaps: finalCorrect, totalTaps: finalTotal, accuracy, cps, date: Date.now() });
        }
        return finalTotal;
      });
      return finalCorrect;
    });
  }

  function handleTap(circle) {
    if (isFinished) return;
    if (circle.number === target) {
      triggerHaptic('success');
      playSound('correct');
      setCorrectTaps((c) => c + 1);
      setTotalTaps((t) => t + 1);
      setCircles((prev) => {
        const remaining = prev.filter((c) => c.id !== circle.id);
        const currentNums = remaining.map((c) => c.number);
        const newNum = pickUniqueNumber(currentNums);
        const pos = findNonOverlappingPosition(areaSize.width, areaSize.height, diameter, remaining);
        const next = [...remaining, { id: `r${newNum}_${Date.now()}`, number: newNum, x: pos.x, y: pos.y }];
        setTarget(next[Math.floor(Math.random() * next.length)].number);
        return next;
      });
    } else {
      triggerHaptic('error');
      playSound('wrong');
      setTotalTaps((t) => t + 1);
      setFlashCircleId(circle.id);
      setTimeout(() => setFlashCircleId((id) => (id === circle.id ? null : id)), 160);
    }
  }

  function handleReset() {
    initializedRef.current = true;
    start(areaSize.width, areaSize.height);
  }

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.background }]} edges={['left', 'right']}>
      <StatusBar barStyle={theme.key === 'minimalLight' ? 'dark-content' : 'light-content'} />

      <View style={[styles.hud, { backgroundColor: theme.headerBg, borderBottomColor: theme.buttonBg, paddingTop: insets.top + EDGE_BUFFER }]}>
        <View style={styles.hudLeft}>
          <Text style={[styles.hudTargetLabel, { color: theme.textSecondary }]}>TIME LEFT</Text>
          <Text style={[styles.hudTargetValue, { color: theme.accent }]}>{formatSeconds(remainingMs)}</Text>
        </View>
        <View style={styles.hudCenter}>
          <Text style={[styles.hudTargetLabel, { color: theme.textSecondary }]}>FIND</Text>
          <Text style={[styles.hudTimer, { color: theme.accent, fontSize: 28 }]}>{target ?? '-'}</Text>
        </View>
        <View style={styles.hudRight}>
          <Pressable onPress={handleReset} style={styles.hudIconButton} hitSlop={10}>
            <Text style={[styles.hudIconText, { color: theme.textPrimary }]}>⟲</Text>
          </Pressable>
          <Pressable onPress={onExit} style={styles.hudIconButton} hitSlop={10}>
            <Text style={[styles.hudIconText, { color: theme.textPrimary }]}>☰</Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.playArea, { paddingBottom: insets.bottom + EDGE_BUFFER }]} onLayout={handleLayout}>
        {circles.map((circle) => {
          const isFlashing = flashCircleId === circle.id;
          return (
            <Pressable
              key={circle.id}
              onPress={() => handleTap(circle)}
              style={[
                styles.circle,
                {
                  width: diameter,
                  height: diameter,
                  borderRadius: diameter / 2,
                  left: circle.x - diameter / 2,
                  top: circle.y - diameter / 2,
                  backgroundColor: isFlashing ? theme.danger : theme.circleBg,
                  borderColor: isFlashing ? theme.danger : theme.circleBorder,
                },
              ]}
              hitSlop={4}
            >
              <Text style={[styles.circleText, { color: isFlashing ? '#fff' : theme.circleText, fontSize: Math.max(14, diameter * 0.32) }]}>
                {circle.number}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Modal visible={isFinished && !!result} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.victoryCard, { backgroundColor: theme.surface }]}>
            {result?.isNewBest ? (
              <View style={[styles.badge, { backgroundColor: theme.accent }]}>
                <Text style={styles.badgeText}>NEW HIGH SCORE!</Text>
              </View>
            ) : null}
            <Text style={[styles.victoryTitle, { color: theme.textPrimary }]}>Time's Up</Text>
            <View style={styles.victoryStatsGrid}>
              <VictoryStat label="Correct" value={result ? String(result.correctTaps) : '--'} theme={theme} />
              <VictoryStat label="Accuracy" value={result ? `${result.accuracy.toFixed(1)}%` : '--'} theme={theme} />
              <VictoryStat label="Total Taps" value={result ? String(result.totalTaps) : '--'} theme={theme} />
              <VictoryStat label="Finds/sec" value={result ? result.cps.toFixed(2) : '--'} theme={theme} />
            </View>
            <PrimaryButton label="TRY AGAIN" theme={theme} onPress={handleReset} style={{ marginTop: 22 }} />
            <SecondaryButton label="MODE SELECT" theme={theme} onPress={onExit} style={{ marginTop: 12 }} />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/* -------------------------------------------------------------------------- */
/*  REACTION TIME - SOLO                                                     */
/* -------------------------------------------------------------------------- */

function ReactionTimeScreen({ theme, rounds, bests, onExit, onRecordResult }) {
  const insets = useSafeAreaInsets();
  const playSound = useGameSounds(true);
  const triggerHaptic = useHaptics(true);
  const bestsKey = `reaction_${rounds}`;

  const [phase, setPhase] = useState('intro'); // intro | waiting | ready | tooSoon | between | result
  const [roundIndex, setRoundIndex] = useState(0);
  const [result, setResult] = useState(null);

  const timesRef = useRef([]);
  const readyAtRef = useRef(null);
  const timeoutRef = useRef(null);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  function beginRound() {
    setPhase('waiting');
    const delay = 1000 + Math.random() * 2000;
    timeoutRef.current = setTimeout(() => {
      readyAtRef.current = Date.now();
      setPhase('ready');
    }, delay);
  }

  function finishReaction() {
    const times = timesRef.current;
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const best = Math.min(...times);
    const worst = Math.max(...times);
    const prevBest = bests[bestsKey];
    const isNewBest = !prevBest || avg < prevBest.avg;
    setResult({ avg, best, worst, isNewBest });
    setPhase('result');
    triggerHaptic('finish');
    playSound('finish');
    if (isNewBest) {
      onRecordResult(bestsKey, { avg, best, worst, date: Date.now() });
    }
  }

  function handlePress() {
    if (phase === 'intro') {
      timesRef.current = [];
      setRoundIndex(0);
      beginRound();
      return;
    }
    if (phase === 'waiting') {
      clearTimeout(timeoutRef.current);
      triggerHaptic('error');
      playSound('wrong');
      setPhase('tooSoon');
      timeoutRef.current = setTimeout(() => beginRound(), 900);
      return;
    }
    if (phase === 'ready') {
      const rt = Date.now() - readyAtRef.current;
      timesRef.current = [...timesRef.current, rt];
      triggerHaptic('success');
      playSound('correct');
      const next = roundIndex + 1;
      if (next >= rounds) {
        finishReaction();
      } else {
        setRoundIndex(next);
        setPhase('between');
        timeoutRef.current = setTimeout(() => beginRound(), 700);
      }
      return;
    }
  }

  function handleReset() {
    clearTimeout(timeoutRef.current);
    setPhase('intro');
    setResult(null);
  }

  const bgColor =
    phase === 'ready'
      ? theme.success
      : phase === 'waiting' || phase === 'tooSoon'
      ? theme.danger
      : theme.background;

  const message =
    phase === 'intro'
      ? 'Tap to start'
      : phase === 'waiting'
      ? 'Wait for green…'
      : phase === 'tooSoon'
      ? 'Too soon! Wait for green.'
      : phase === 'ready'
      ? 'TAP NOW!'
      : phase === 'between'
      ? 'Get ready…'
      : '';

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.background }]} edges={['left', 'right']}>
      <StatusBar barStyle="light-content" />
      <View style={[styles.hud, { backgroundColor: theme.headerBg, borderBottomColor: theme.buttonBg, paddingTop: insets.top + EDGE_BUFFER }]}>
        <View style={styles.hudLeft}>
          <Text style={[styles.hudTargetLabel, { color: theme.textSecondary }]}>ROUND</Text>
          <Text style={[styles.hudTargetValue, { color: theme.accent }]}>
            {phase === 'intro' ? '-' : `${Math.min(roundIndex + 1, rounds)}/${rounds}`}
          </Text>
        </View>
        <View style={styles.hudCenter} />
        <View style={styles.hudRight}>
          <Pressable onPress={onExit} style={styles.hudIconButton} hitSlop={10}>
            <Text style={[styles.hudIconText, { color: theme.textPrimary }]}>☰</Text>
          </Pressable>
        </View>
      </View>

      {phase === 'result' ? (
        <View style={[styles.flex, styles.center, { paddingBottom: insets.bottom + EDGE_BUFFER }]}>
          <View style={[styles.victoryCard, { backgroundColor: theme.surface, width: '85%' }]}>
            {result?.isNewBest ? (
              <View style={[styles.badge, { backgroundColor: theme.accent }]}>
                <Text style={styles.badgeText}>NEW HIGH SCORE!</Text>
              </View>
            ) : null}
            <Text style={[styles.victoryTitle, { color: theme.textPrimary }]}>Reaction Results</Text>
            <View style={styles.victoryStatsGrid}>
              <VictoryStat label="Average" value={result ? `${result.avg.toFixed(0)}ms` : '--'} theme={theme} />
              <VictoryStat label="Best" value={result ? `${result.best.toFixed(0)}ms` : '--'} theme={theme} />
              <VictoryStat label="Worst" value={result ? `${result.worst.toFixed(0)}ms` : '--'} theme={theme} />
            </View>
            <PrimaryButton label="TRY AGAIN" theme={theme} onPress={handleReset} style={{ marginTop: 22 }} />
            <SecondaryButton label="MODE SELECT" theme={theme} onPress={onExit} style={{ marginTop: 12 }} />
          </View>
        </View>
      ) : (
        <Pressable style={[styles.flex, styles.center, { backgroundColor: bgColor, paddingBottom: insets.bottom + EDGE_BUFFER }]} onPress={handlePress}>
          <Text style={styles.reactionMessage}>{message}</Text>
        </Pressable>
      )}
    </SafeAreaView>
  );
}

/* -------------------------------------------------------------------------- */
/*  VS / DUEL SHARED PIECES                                                  */
/* -------------------------------------------------------------------------- */

function WinnerOverlay({ theme, label }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 500, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 500, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: theme.success,
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.1, 0.4] }),
          alignItems: 'center',
          justifyContent: 'center',
        },
      ]}
    >
      <Text style={styles.duelBigLabel}>{label}</Text>
    </Animated.View>
  );
}

function LoserOverlay() {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.loserOverlay]}>
      <Text style={styles.loserX}>✕</Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/*  CLASSIC VS                                                               */
/* -------------------------------------------------------------------------- */

function ClassicDuelHalf({ theme, engine, diameter, isWinner, isLoser, label }) {
  return (
    <View style={styles.flex}>
      <View style={styles.duelHud}>
        <Text style={[styles.duelHudLabel, { color: theme.textSecondary }]}>{label} · TARGET</Text>
        <Text style={[styles.duelHudTarget, { color: theme.accent }]}>
          {engine.expectedTarget >= 1 ? engine.expectedTarget : '-'}
        </Text>
        <Text style={[styles.duelHudTimer, { color: theme.textPrimary }]}>{formatTime(engine.elapsedMs)}</Text>
      </View>
      <View style={styles.duelPlayArea} onLayout={engine.onLayout}>
        {engine.circles.map((circle) => {
          const isFlashing = engine.flashCircleId === circle.id;
          return (
            <Pressable
              key={circle.id}
              onPress={() => engine.handleTap(circle)}
              style={[
                styles.circle,
                {
                  width: diameter,
                  height: diameter,
                  borderRadius: diameter / 2,
                  left: circle.x - diameter / 2,
                  top: circle.y - diameter / 2,
                  backgroundColor: isFlashing ? theme.danger : theme.circleBg,
                  borderColor: isFlashing ? theme.danger : theme.circleBorder,
                },
              ]}
            >
              <Text style={[styles.circleText, { color: isFlashing ? '#fff' : theme.circleText, fontSize: Math.max(12, diameter * 0.3) }]}>
                {circle.number}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {isWinner ? <WinnerOverlay theme={theme} label="WINNER" /> : null}
      {isLoser ? <LoserOverlay /> : null}
    </View>
  );
}

function DuelClassicScreen({ theme, settings, onExit }) {
  const insets = useSafeAreaInsets();
  const playSound = useGameSounds(settings.soundEnabled);
  const triggerHaptic = useHaptics(settings.hapticsEnabled);
  const diameter = Math.min(settings.circleSize, 60);

  const [matchOver, setMatchOver] = useState(false);
  const [winner, setWinner] = useState(null);
  const decidedRef = useRef(false);

  function handleFinish(player) {
    if (decidedRef.current) return;
    decidedRef.current = true;
    setWinner(player);
    setMatchOver(true);
    if (player === 1) engine2.setPaused(true);
    else engine1.setPaused(true);
  }

  const engine1 = useClassicGame({
    startNumber: settings.startNumber,
    circleCount: settings.circleCount,
    diameter,
    playSound,
    triggerHaptic,
    onFinish: () => handleFinish(1),
  });
  const engine2 = useClassicGame({
    startNumber: settings.startNumber,
    circleCount: settings.circleCount,
    diameter,
    playSound,
    triggerHaptic,
    onFinish: () => handleFinish(2),
  });

  function handleRematch() {
    decidedRef.current = false;
    setMatchOver(false);
    setWinner(null);
    engine1.reset();
    engine2.reset();
  }

  return (
    <View style={[styles.flex, { backgroundColor: '#000' }]}>
      <StatusBar barStyle="light-content" />
      <View style={[styles.duelHalf, { transform: [{ rotate: '180deg' }], paddingTop: insets.top + EDGE_BUFFER, paddingBottom: EDGE_BUFFER, backgroundColor: theme.background }]}>
        <ClassicDuelHalf theme={theme} engine={engine1} diameter={diameter} isWinner={matchOver && winner === 1} isLoser={matchOver && winner === 2} label="P1" />
      </View>
      <View style={[styles.duelDivider, { backgroundColor: theme.buttonBg }]} />
      <View style={[styles.duelHalf, { paddingTop: EDGE_BUFFER, paddingBottom: insets.bottom + EDGE_BUFFER, backgroundColor: theme.background }]}>
        <ClassicDuelHalf theme={theme} engine={engine2} diameter={diameter} isWinner={matchOver && winner === 2} isLoser={matchOver && winner === 1} label="P2" />
      </View>

      <Modal visible={matchOver} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.victoryCard, { backgroundColor: theme.surface }]}>
            <Text style={[styles.victoryTitle, { color: theme.textPrimary }]}>
              {winner === 1 ? 'Player 1 Wins!' : 'Player 2 Wins!'}
            </Text>
            <PrimaryButton label="REMATCH" theme={theme} onPress={handleRematch} style={{ marginTop: 10 }} />
            <SecondaryButton label="MODE SELECT" theme={theme} onPress={onExit} style={{ marginTop: 12 }} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/*  CPS VS                                                                   */
/* -------------------------------------------------------------------------- */

function CpsDuelHalf({ theme, engine, isWinner, isLoser, label }) {
  return (
    <Pressable style={styles.flex} onPress={engine.handleTap}>
      <View style={styles.duelHud}>
        <Text style={[styles.duelHudLabel, { color: theme.textSecondary }]}>{label} · TIME LEFT</Text>
        <Text style={[styles.duelHudTarget, { color: theme.accent }]}>{formatSeconds(engine.remainingMs)}</Text>
      </View>
      <View style={[styles.flex, styles.center]}>
        <Text style={[styles.duelTapCount, { color: theme.circleText }]}>{engine.totalTaps}</Text>
        <Text style={{ color: theme.textSecondary, fontSize: 11, marginTop: 4 }}>TAP ANYWHERE</Text>
      </View>
      {isWinner ? <WinnerOverlay theme={theme} label="WINNER" /> : null}
      {isLoser ? <LoserOverlay /> : null}
    </Pressable>
  );
}

function DuelCpsScreen({ theme, settings, durationSec, onExit }) {
  const insets = useSafeAreaInsets();
  const playSound = useGameSounds(settings.soundEnabled);
  const triggerHaptic = useHaptics(settings.hapticsEnabled);

  const [p1Stats, setP1Stats] = useState(null);
  const [p2Stats, setP2Stats] = useState(null);
  const [matchOver, setMatchOver] = useState(false);
  const [winner, setWinner] = useState(null); // 1 | 2 | 'draw'

  const engine1 = useCpsGame({ durationSec, playSound, triggerHaptic, onFinish: setP1Stats });
  const engine2 = useCpsGame({ durationSec, playSound, triggerHaptic, onFinish: setP2Stats });

  useEffect(() => {
    if (p1Stats && p2Stats && !matchOver) {
      let w = 'draw';
      if (p1Stats.totalTaps > p2Stats.totalTaps) w = 1;
      else if (p2Stats.totalTaps > p1Stats.totalTaps) w = 2;
      setWinner(w);
      setMatchOver(true);
    }
  }, [p1Stats, p2Stats, matchOver]);

  function handleRematch() {
    setP1Stats(null);
    setP2Stats(null);
    setMatchOver(false);
    setWinner(null);
    engine1.reset();
    engine2.reset();
  }

  return (
    <View style={[styles.flex, { backgroundColor: '#000' }]}>
      <StatusBar barStyle="light-content" />
      <View style={[styles.duelHalf, { transform: [{ rotate: '180deg' }], paddingTop: insets.top + EDGE_BUFFER, paddingBottom: EDGE_BUFFER, backgroundColor: theme.background }]}>
        <CpsDuelHalf theme={theme} engine={engine1} isWinner={matchOver && winner === 1} isLoser={matchOver && winner === 2} label="P1" />
      </View>
      <View style={[styles.duelDivider, { backgroundColor: theme.buttonBg }]} />
      <View style={[styles.duelHalf, { paddingTop: EDGE_BUFFER, paddingBottom: insets.bottom + EDGE_BUFFER, backgroundColor: theme.background }]}>
        <CpsDuelHalf theme={theme} engine={engine2} isWinner={matchOver && winner === 2} isLoser={matchOver && winner === 1} label="P2" />
      </View>

      <Modal visible={matchOver} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.victoryCard, { backgroundColor: theme.surface }]}>
            <Text style={[styles.victoryTitle, { color: theme.textPrimary }]}>
              {winner === 'draw' ? "It's a Draw!" : winner === 1 ? 'Player 1 Wins!' : 'Player 2 Wins!'}
            </Text>
            <View style={styles.victoryStatsGrid}>
              <VictoryStat label="P1 Taps" value={p1Stats ? String(p1Stats.totalTaps) : '--'} theme={theme} />
              <VictoryStat label="P2 Taps" value={p2Stats ? String(p2Stats.totalTaps) : '--'} theme={theme} />
            </View>
            <PrimaryButton label="REMATCH" theme={theme} onPress={handleRematch} style={{ marginTop: 10 }} />
            <SecondaryButton label="MODE SELECT" theme={theme} onPress={onExit} style={{ marginTop: 12 }} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/*  ROOT APP                                                                  */
/* -------------------------------------------------------------------------- */

function AppInner() {
  const [screen, setScreen] = useState('menu'); // menu | settings | modes | game
  const [gameConfig, setGameConfig] = useState({ mode: 'classic', params: {} });
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [bests, setBests] = useState({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [rawSettings, rawBests] = await Promise.all([
          AsyncStorage.getItem(STORAGE_SETTINGS_KEY),
          AsyncStorage.getItem(STORAGE_BESTS_KEY),
        ]);
        if (rawSettings) setSettings((prev) => ({ ...prev, ...JSON.parse(rawSettings) }));
        if (rawBests) setBests(JSON.parse(rawBests));
      } catch (e) {
        // fall back to defaults
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  // Android hardware back button: step back through the screen stack instead
  // of exiting the app, except from the main menu (standard behavior there).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen === 'settings' || screen === 'modes') {
        setScreen('menu');
        return true;
      }
      if (screen === 'game') {
        setScreen('modes');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [screen]);

  const updateSettings = useCallback((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      AsyncStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const recordResult = useCallback((key, record) => {
    setBests((prev) => {
      const next = { ...prev, [key]: record };
      AsyncStorage.setItem(STORAGE_BESTS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const theme = useMemo(() => THEMES[settings.themeKey] || THEMES.darkCyber, [settings.themeKey]);

  function handlePlay(mode, params) {
    setGameConfig({ mode, params });
    setScreen('game');
  }

  if (!hydrated) {
    return (
      <SafeAreaView style={[styles.flex, styles.center, { backgroundColor: THEMES.darkCyber.background }]}>
        <Text style={{ color: THEMES.darkCyber.accent, fontSize: 16 }}>Loading…</Text>
      </SafeAreaView>
    );
  }

  if (screen === 'settings') {
    return <SettingsScreen theme={theme} settings={settings} onChange={updateSettings} onBack={() => setScreen('menu')} />;
  }

  if (screen === 'modes') {
    return <ModeSelectScreen theme={theme} settings={settings} onBack={() => setScreen('menu')} onPlay={handlePlay} />;
  }

  if (screen === 'game') {
    const exitToModes = () => setScreen('modes');
    switch (gameConfig.mode) {
      case 'classic':
        return (
          <ClassicSoloScreen
            theme={theme}
            settings={settings}
            bests={bests}
            onExit={exitToModes}
            onRecordResult={recordResult}
            bestsPrefix="classic"
          />
        );
      case 'coop':
        return (
          <ClassicSoloScreen
            theme={theme}
            settings={settings}
            bests={bests}
            onExit={exitToModes}
            onRecordResult={recordResult}
            circleCountOverride={settings.circleCount + 2}
            bestsPrefix="coop"
            headerLabel="TEAM TARGET"
          />
        );
      case 'cps':
        return (
          <CpsSoloScreen
            theme={theme}
            settings={settings}
            durationSec={gameConfig.params.durationSec}
            bests={bests}
            onExit={exitToModes}
            onRecordResult={recordResult}
          />
        );
      case 'random':
        return (
          <RandomTargetScreen
            theme={theme}
            settings={settings}
            durationSec={gameConfig.params.durationSec}
            bests={bests}
            onExit={exitToModes}
            onRecordResult={recordResult}
          />
        );
      case 'reaction':
        return (
          <ReactionTimeScreen
            theme={theme}
            rounds={gameConfig.params.rounds}
            bests={bests}
            onExit={exitToModes}
            onRecordResult={recordResult}
          />
        );
      case 'classicVs':
        return <DuelClassicScreen theme={theme} settings={settings} onExit={exitToModes} />;
      case 'cpsVs':
        return <DuelCpsScreen theme={theme} settings={settings} durationSec={gameConfig.params.durationSec} onExit={exitToModes} />;
      default:
        return (
          <ClassicSoloScreen theme={theme} settings={settings} bests={bests} onExit={exitToModes} onRecordResult={recordResult} bestsPrefix="classic" />
        );
    }
  }

  return (
    <MainMenuScreen
      theme={theme}
      settings={settings}
      bests={bests}
      onStart={() => setScreen('modes')}
      onOpenSettings={() => setScreen('settings')}
    />
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

/* -------------------------------------------------------------------------- */
/*  STYLES                                                                    */
/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },

  menuContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  title: { fontSize: 40, fontWeight: '800', letterSpacing: 3 },
  subtitle: { fontSize: 14, marginTop: 8, marginBottom: 40 },
  menuButtonGroup: { width: '100%', maxWidth: 320 },
  bestCard: { marginTop: 48, width: '100%', maxWidth: 340, borderRadius: 16, borderWidth: 1, padding: 18 },
  bestCardTitle: { fontSize: 13, fontWeight: '600' },
  bestStatsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  bestStat: { alignItems: 'center', flex: 1 },
  bestStatValue: { fontSize: 20, fontWeight: '700' },
  bestStatLabel: { fontSize: 11, marginTop: 2 },

  primaryButton: { paddingVertical: 16, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#04121a', fontSize: 16, fontWeight: '800', letterSpacing: 1 },
  secondaryButton: { paddingVertical: 13, paddingHorizontal: 16, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
  secondaryButtonText: { fontSize: 14, fontWeight: '700' },

  settingsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1 },
  backArrow: { fontSize: 16, fontWeight: '700' },
  settingsTitle: { fontSize: 17, fontWeight: '700' },
  settingsScroll: { padding: 20 },
  sectionLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 1, marginTop: 22, marginBottom: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: { minWidth: 64 },
  customRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 10 },
  textInput: { borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, minWidth: 70, fontSize: 15 },
  themeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  themeCard: { width: '47%', borderRadius: 14, borderWidth: 2, padding: 14, alignItems: 'center' },
  themeSwatch: { width: 44, height: 44, borderRadius: 22, borderWidth: 3, marginBottom: 8 },
  themeCardLabel: { fontSize: 12, fontWeight: '600', textAlign: 'center' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: 1 },

  modeCard: { borderRadius: 16, borderWidth: 1, padding: 16, marginBottom: 14 },
  modeCardTitle: { fontSize: 16, fontWeight: '800' },
  modeCardDesc: { fontSize: 13, marginTop: 6, lineHeight: 18 },
  modeCardFootnote: { fontSize: 11, marginTop: 10, fontStyle: 'italic' },
  moreModesNote: { fontSize: 12, textAlign: 'center', marginTop: 8, marginBottom: 10, lineHeight: 18 },

  hud: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1 },
  hudLeft: { alignItems: 'flex-start', minWidth: 70 },
  hudTargetLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  hudTargetValue: { fontSize: 30, fontWeight: '800', lineHeight: 34 },
  hudCenter: { alignItems: 'center', flex: 1 },
  hudTimer: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  hudSubStats: { fontSize: 11, marginTop: 2 },
  hudRight: { flexDirection: 'row', minWidth: 70, justifyContent: 'flex-end' },
  hudIconButton: { paddingHorizontal: 8, paddingVertical: 4 },
  hudIconText: { fontSize: 22 },

  playArea: { flex: 1, position: 'relative', overflow: 'hidden' },
  circle: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    ...Platform.select({
      android: { elevation: 3 },
      ios: { shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
    }),
  },
  circleText: { fontWeight: '800' },

  tapZone: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tapZoneCircle: { width: 220, height: 220, borderRadius: 110, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  tapZoneNumber: { fontSize: 56, fontWeight: '900' },
  tapZoneHint: { fontSize: 12, marginTop: 6, letterSpacing: 1 },

  reactionMessage: { color: '#fff', fontSize: 26, fontWeight: '800', textAlign: 'center', paddingHorizontal: 24 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  pauseCard: { width: '100%', maxWidth: 320, borderRadius: 18, padding: 24, alignItems: 'stretch' },
  pauseTitle: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  victoryCard: { width: '100%', maxWidth: 360, borderRadius: 20, padding: 26, alignItems: 'stretch' },
  badge: { alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, marginBottom: 12 },
  badgeText: { color: '#04121a', fontWeight: '800', fontSize: 12, letterSpacing: 0.5 },
  victoryTitle: { fontSize: 22, fontWeight: '800', textAlign: 'center', marginBottom: 18 },
  victoryStatsGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  victoryStat: { width: '48%', alignItems: 'center', marginBottom: 16 },
  victoryStatValue: { fontSize: 24, fontWeight: '800' },
  victoryStatLabel: { fontSize: 12, marginTop: 2 },

  duelHalf: { flex: 1, overflow: 'hidden' },
  duelDivider: { height: 3, width: '100%' },
  duelHud: { alignItems: 'center', paddingVertical: 6 },
  duelHudLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  duelHudTarget: { fontSize: 26, fontWeight: '800' },
  duelHudTimer: { fontSize: 14, fontWeight: '600' },
  duelPlayArea: { flex: 1, position: 'relative' },
  duelTapCount: { fontSize: 64, fontWeight: '900' },
  duelBigLabel: { fontSize: 30, fontWeight: '900', color: '#fff' },
  loserOverlay: { backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  loserX: { fontSize: 64, fontWeight: '900', color: '#ff3b3b' },
});

/**
 * CPS TRAINER - Descending Number Tap Game
 * Single-file offline React Native (Expo) app.
 *
 * Features:
 *  - Tap numbers in strict descending order from a configurable Max Number down to 1
 *  - Up to N circles on screen at once, non-overlapping, identical size
 *  - Live MM:SS:hh timer, taps/accuracy/CPS tracking
 *  - Settings screen with AsyncStorage persistence (start number, circle count,
 *    circle size, color theme, haptics, sound effects)
 *  - Synthesized beep sound effects generated at runtime (no external audio assets)
 *  - Personal best tracking per configuration, stored locally
 *
 * Dependencies (see package.json):
 *  expo, react, react-native,
 *  @react-native-async-storage/async-storage,
 *  expo-haptics,
 *  expo-av
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SafeAreaView,
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
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';

/* -------------------------------------------------------------------------- */
/*  CONSTANTS                                                                  */
/* -------------------------------------------------------------------------- */

const STORAGE_SETTINGS_KEY = 'cps_trainer_settings_v1';
const STORAGE_BESTS_KEY = 'cps_trainer_bests_v1';

const START_NUMBER_PRESETS = [20, 30, 50, 75, 100];
const CIRCLE_COUNT_PRESETS = [3, 4, 5, 6, 7];
const CIRCLE_SIZE_PRESETS = [
  { label: 'Small', value: 55 },
  { label: 'Medium', value: 70 },
  { label: 'Large', value: 85 },
];

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
  harmonic = null, // { freq, mix } optional second tone mixed in
  glide = 0, // Hz to glide upward over the duration (0 = none)
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
  writeUint16LE(buffer, 20, 1); // PCM
  writeUint16LE(buffer, 22, 1); // mono
  writeUint32LE(buffer, 24, sampleRate);
  writeUint32LE(buffer, 28, sampleRate); // byte rate (1 byte/sample * 1 channel)
  writeUint16LE(buffer, 32, 1); // block align
  writeUint16LE(buffer, 34, 8); // bits per sample
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

// Pre-computed data URIs for our three cues (generated once at module load).
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

/**
 * Small hook that lazily loads the three synthesized sound cues and exposes
 * a play(name) function. Safe to call play() even if sounds are disabled or
 * still loading (it will just no-op).
 */
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
        // Fail silently - sound is a non-critical enhancement.
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

function configKeyFor(settings) {
  return `${settings.startNumber}_${settings.circleCount}`;
}

function distance(x1, y1, x2, y2) {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Finds a random (x, y) center position for a new circle inside
 * [0, width] x [0, height] such that it does not overlap any circle
 * already in `existing` (array of {x, y}) and stays within padding
 * from the play-area edges.
 */
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

  // Fallback: sweep a grid to guarantee we find *some* valid, non-overlapping
  // spot even in a crowded play area, rather than giving up.
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

  // Last resort: return a random point even if it overlaps slightly.
  return {
    x: minX + Math.random() * (maxX - minX),
    y: minY + Math.random() * (maxY - minY),
  };
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

/* -------------------------------------------------------------------------- */
/*  MAIN MENU SCREEN                                                          */
/* -------------------------------------------------------------------------- */

function MainMenuScreen({ theme, settings, bests, onStart, onOpenSettings }) {
  const key = configKeyFor(settings);
  const best = bests[key];

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.background }]}>
      <View style={styles.menuContainer}>
        <Text style={[styles.title, { color: theme.accent }]}>CPS TRAINER</Text>
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
          Tap. Descend. Improve your speed.
        </Text>

        <View style={styles.menuButtonGroup}>
          <PrimaryButton label="START GAME" onPress={onStart} theme={theme} />
          <SecondaryButton
            label="SETTINGS"
            onPress={onOpenSettings}
            theme={theme}
            style={{ marginTop: 14 }}
          />
        </View>

        <View style={[styles.bestCard, { backgroundColor: theme.surface, borderColor: theme.buttonBg }]}>
          <Text style={[styles.bestCardTitle, { color: theme.textPrimary }]}>
            Personal Best · {settings.startNumber} numbers / {settings.circleCount} circles
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
        {/* Starting number */}
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

        {/* Circle count */}
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

        {/* Circle size */}
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

        {/* Theme */}
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

        {/* Haptics & sound */}
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
/*  GAME SCREEN                                                               */
/* -------------------------------------------------------------------------- */

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

function GameScreen({ theme, settings, bests, onExit, onRecordResult }) {
  const { width, height } = useWindowDimensions();
  const diameter = settings.circleSize;

  const [playAreaSize, setPlayAreaSize] = useState({ width: 0, height: 0 });
  const [circles, setCircles] = useState([]);
  const [expectedTarget, setExpectedTarget] = useState(settings.startNumber);
  const [totalTaps, setTotalTaps] = useState(0);
  const [correctTaps, setCorrectTaps] = useState(0);
  const [missedTaps, setMissedTaps] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [flashCircleId, setFlashCircleId] = useState(null); // wrong-tap flash
  const [result, setResult] = useState(null); // victory stats snapshot

  const nextSpawnRef = useRef(null);
  const startTimeRef = useRef(null);
  const pausedAtRef = useRef(null);
  const pausedTotalRef = useRef(0);
  const intervalRef = useRef(null);
  const initializedRef = useRef(false);

  const playSound = useGameSounds(settings.soundEnabled);

  const triggerHaptic = useCallback(
    (type) => {
      if (!settings.hapticsEnabled) return;
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
    [settings.hapticsEnabled]
  );

  const startGame = useCallback(
    (areaWidth, areaHeight) => {
      const w = areaWidth || playAreaSize.width;
      const h = areaHeight || playAreaSize.height;
      if (!w || !h) return;

      const initial = buildInitialCircles(settings.startNumber, settings.circleCount, w, h, diameter);
      setCircles(initial);
      setExpectedTarget(settings.startNumber);
      nextSpawnRef.current = settings.startNumber - settings.circleCount;
      setTotalTaps(0);
      setCorrectTaps(0);
      setMissedTaps(0);
      setElapsedMs(0);
      setIsFinished(false);
      setIsPaused(false);
      setResult(null);
      pausedTotalRef.current = 0;
      startTimeRef.current = Date.now();
      setIsRunning(true);
    },
    [settings.startNumber, settings.circleCount, diameter, playAreaSize]
  );

  // Kick off the run once we know the play area's dimensions.
  const handlePlayAreaLayout = useCallback(
    (e) => {
      const { width: w, height: h } = e.nativeEvent.layout;
      setPlayAreaSize({ width: w, height: h });
      if (!initializedRef.current && w > 0 && h > 0) {
        initializedRef.current = true;
        startGame(w, h);
      }
    },
    [startGame]
  );

  // Timer loop
  useEffect(() => {
    if (isRunning && !isPaused && !isFinished) {
      intervalRef.current = setInterval(() => {
        if (startTimeRef.current != null) {
          setElapsedMs(Date.now() - startTimeRef.current - pausedTotalRef.current);
        }
      }, 30);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isRunning, isPaused, isFinished]);

  function finishGame(finalTotalTaps, finalCorrectTaps, finalMissed) {
    const finalElapsed = Date.now() - startTimeRef.current - pausedTotalRef.current;
    setElapsedMs(finalElapsed);
    setIsRunning(false);
    setIsFinished(true);
    const seconds = Math.max(finalElapsed / 1000, 0.01);
    const accuracy = finalTotalTaps > 0 ? (finalCorrectTaps / finalTotalTaps) * 100 : 100;
    const cps = finalTotalTaps / seconds;
    const key = configKeyFor(settings);
    const prevBest = bests[key];
    const isNewBest = !prevBest || finalElapsed < prevBest.timeMs;
    const summary = {
      timeMs: finalElapsed,
      accuracy,
      cps,
      missed: finalMissed,
      isNewBest,
    };
    setResult(summary);
    triggerHaptic('finish');
    playSound('finish');
    if (isNewBest) {
      onRecordResult(key, { timeMs: finalElapsed, accuracy, cps, date: Date.now() });
    }
  }

  const handleCirclePress = useCallback(
    (circle) => {
      if (isFinished || isPaused) return;

      if (circle.number === expectedTarget) {
        // Correct tap.
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
            const pos = findNonOverlappingPosition(
              playAreaSize.width,
              playAreaSize.height,
              diameter,
              remaining
            );
            next = [...remaining, { id: `c${spawnNum}`, number: spawnNum, x: pos.x, y: pos.y }];
          }
          return next;
        });

        const newExpected = expectedTarget - 1;
        setExpectedTarget(newExpected);

        if (newExpected < 1) {
          // That was the tap on "1" - the run is complete.
          finishGame(newTotal, newCorrect, missedTaps);
        }
      } else {
        // Wrong tap - out of order.
        triggerHaptic('error');
        playSound('wrong');
        setTotalTaps((t) => t + 1);
        setMissedTaps((m) => m + 1);
        setFlashCircleId(circle.id);
        setTimeout(() => setFlashCircleId((id) => (id === circle.id ? null : id)), 160);
      }
    },
    [expectedTarget, totalTaps, correctTaps, missedTaps, isFinished, isPaused, playAreaSize, diameter, triggerHaptic, playSound]
  );

  function handleReset() {
    initializedRef.current = true;
    startGame(playAreaSize.width, playAreaSize.height);
  }

  function handlePauseToggle() {
    if (isFinished) return;
    if (!isPaused) {
      pausedAtRef.current = Date.now();
      setIsPaused(true);
    } else {
      if (pausedAtRef.current != null) {
        pausedTotalRef.current += Date.now() - pausedAtRef.current;
      }
      setIsPaused(false);
    }
  }

  const accuracyLive = totalTaps > 0 ? (correctTaps / totalTaps) * 100 : 100;
  const cpsLive = elapsedMs > 0 ? totalTaps / (elapsedMs / 1000) : 0;

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.background }]}>
      <StatusBar barStyle={theme.key === 'minimalLight' ? 'dark-content' : 'light-content'} />

      {/* HUD */}
      <View style={[styles.hud, { backgroundColor: theme.headerBg, borderBottomColor: theme.buttonBg }]}>
        <View style={styles.hudLeft}>
          <Text style={[styles.hudTargetLabel, { color: theme.textSecondary }]}>TARGET</Text>
          <Text style={[styles.hudTargetValue, { color: theme.accent }]}>
            {expectedTarget >= 1 ? expectedTarget : '-'}
          </Text>
        </View>

        <View style={styles.hudCenter}>
          <Text style={[styles.hudTimer, { color: theme.textPrimary }]}>{formatTime(elapsedMs)}</Text>
          <Text style={[styles.hudSubStats, { color: theme.textSecondary }]}>
            CPS {cpsLive.toFixed(1)} · Acc {accuracyLive.toFixed(0)}%
          </Text>
        </View>

        <View style={styles.hudRight}>
          <Pressable onPress={handleReset} style={styles.hudIconButton} hitSlop={10}>
            <Text style={[styles.hudIconText, { color: theme.textPrimary }]}>⟲</Text>
          </Pressable>
          <Pressable onPress={handlePauseToggle} style={styles.hudIconButton} hitSlop={10}>
            <Text style={[styles.hudIconText, { color: theme.textPrimary }]}>☰</Text>
          </Pressable>
        </View>
      </View>

      {/* Play area */}
      <View style={styles.playArea} onLayout={handlePlayAreaLayout}>
        {circles.map((circle) => {
          const isFlashing = flashCircleId === circle.id;
          return (
            <Pressable
              key={circle.id}
              onPress={() => handleCirclePress(circle)}
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
                  {
                    color: isFlashing ? '#ffffff' : theme.circleText,
                    fontSize: Math.max(14, diameter * 0.32),
                  },
                ]}
              >
                {circle.number}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Pause overlay */}
      <Modal visible={isPaused && !isFinished} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.pauseCard, { backgroundColor: theme.surface }]}>
            <Text style={[styles.pauseTitle, { color: theme.textPrimary }]}>Paused</Text>
            <PrimaryButton
              label="RESUME"
              theme={theme}
              onPress={handlePauseToggle}
              style={{ marginTop: 18 }}
            />
            <SecondaryButton
              label="RESTART RUN"
              theme={theme}
              onPress={() => {
                setIsPaused(false);
                handleReset();
              }}
              style={{ marginTop: 12 }}
            />
            <SecondaryButton
              label="MAIN MENU"
              theme={theme}
              onPress={() => onExit()}
              style={{ marginTop: 12 }}
            />
          </View>
        </View>
      </Modal>

      {/* Victory modal */}
      <Modal visible={isFinished && !!result} transparent animationType="fade">
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
              <VictoryStat
                label="Accuracy"
                value={result ? `${result.accuracy.toFixed(1)}%` : '--'}
                theme={theme}
              />
              <VictoryStat label="CPS" value={result ? result.cps.toFixed(2) : '--'} theme={theme} />
              <VictoryStat label="Missed" value={result ? String(result.missed) : '--'} theme={theme} />
            </View>

            <PrimaryButton label="PLAY AGAIN" theme={theme} onPress={handleReset} style={{ marginTop: 22 }} />
            <SecondaryButton label="MAIN MENU" theme={theme} onPress={() => onExit()} style={{ marginTop: 12 }} />
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
/*  ROOT APP                                                                  */
/* -------------------------------------------------------------------------- */

export default function App() {
  const [screen, setScreen] = useState('menu'); // 'menu' | 'settings' | 'game'
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [bests, setBests] = useState({});
  const [hydrated, setHydrated] = useState(false);

  // Load persisted settings & personal bests on mount.
  useEffect(() => {
    (async () => {
      try {
        const [rawSettings, rawBests] = await Promise.all([
          AsyncStorage.getItem(STORAGE_SETTINGS_KEY),
          AsyncStorage.getItem(STORAGE_BESTS_KEY),
        ]);
        if (rawSettings) {
          setSettings((prev) => ({ ...prev, ...JSON.parse(rawSettings) }));
        }
        if (rawBests) {
          setBests(JSON.parse(rawBests));
        }
      } catch (e) {
        // Storage unavailable / corrupt data - fall back to defaults.
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

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

  if (!hydrated) {
    return (
      <SafeAreaView style={[styles.flex, styles.center, { backgroundColor: THEMES.darkCyber.background }]}>
        <Text style={{ color: THEMES.darkCyber.accent, fontSize: 16 }}>Loading…</Text>
      </SafeAreaView>
    );
  }

  if (screen === 'settings') {
    return (
      <SettingsScreen
        theme={theme}
        settings={settings}
        onChange={updateSettings}
        onBack={() => setScreen('menu')}
      />
    );
  }

  if (screen === 'game') {
    return (
      <GameScreen
        theme={theme}
        settings={settings}
        bests={bests}
        onExit={() => setScreen('menu')}
        onRecordResult={recordResult}
      />
    );
  }

  return (
    <MainMenuScreen
      theme={theme}
      settings={settings}
      bests={bests}
      onStart={() => setScreen('game')}
      onOpenSettings={() => setScreen('settings')}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  STYLES                                                                    */
/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },

  // Main menu
  menuContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  title: { fontSize: 40, fontWeight: '800', letterSpacing: 3 },
  subtitle: { fontSize: 14, marginTop: 8, marginBottom: 40 },
  menuButtonGroup: { width: '100%', maxWidth: 320 },
  bestCard: {
    marginTop: 48,
    width: '100%',
    maxWidth: 340,
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
  },
  bestCardTitle: { fontSize: 13, fontWeight: '600' },
  bestStatsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  bestStat: { alignItems: 'center', flex: 1 },
  bestStatValue: { fontSize: 20, fontWeight: '700' },
  bestStatLabel: { fontSize: 11, marginTop: 2 },

  // Buttons
  primaryButton: {
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { color: '#04121a', fontSize: 16, fontWeight: '800', letterSpacing: 1 },
  secondaryButton: {
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  secondaryButtonText: { fontSize: 14, fontWeight: '700' },

  // Settings
  settingsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  backArrow: { fontSize: 16, fontWeight: '700' },
  settingsTitle: { fontSize: 17, fontWeight: '700' },
  settingsScroll: { padding: 20 },
  sectionLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 1, marginTop: 22, marginBottom: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: { minWidth: 64 },
  customRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 10 },
  textInput: {
    borderWidth: 1.5,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 70,
    fontSize: 15,
  },
  themeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  themeCard: {
    width: '47%',
    borderRadius: 14,
    borderWidth: 2,
    padding: 14,
    alignItems: 'center',
  },
  themeSwatch: { width: 44, height: 44, borderRadius: 22, borderWidth: 3, marginBottom: 8 },
  themeCardLabel: { fontSize: 12, fontWeight: '600', textAlign: 'center' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
  },

  // Game HUD
  hud: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  hudLeft: { alignItems: 'flex-start', minWidth: 70 },
  hudTargetLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  hudTargetValue: { fontSize: 30, fontWeight: '800', lineHeight: 34 },
  hudCenter: { alignItems: 'center', flex: 1 },
  hudTimer: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  hudSubStats: { fontSize: 11, marginTop: 2 },
  hudRight: { flexDirection: 'row', minWidth: 70, justifyContent: 'flex-end' },
  hudIconButton: { paddingHorizontal: 8, paddingVertical: 4 },
  hudIconText: { fontSize: 22 },

  // Play area / circles
  playArea: { flex: 1, position: 'relative', overflow: 'hidden' },
  circle: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    ...Platform.select({
      android: { elevation: 3 },
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.25,
        shadowRadius: 4,
        shadowOffset: { width: 0, height: 2 },
      },
    }),
  },
  circleText: { fontWeight: '800' },

  // Modals
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  pauseCard: { width: '100%', maxWidth: 320, borderRadius: 18, padding: 24, alignItems: 'stretch' },
  pauseTitle: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  victoryCard: { width: '100%', maxWidth: 360, borderRadius: 20, padding: 26, alignItems: 'stretch' },
  badge: {
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    marginBottom: 12,
  },
  badgeText: { color: '#04121a', fontWeight: '800', fontSize: 12, letterSpacing: 0.5 },
  victoryTitle: { fontSize: 22, fontWeight: '800', textAlign: 'center', marginBottom: 18 },
  victoryStatsGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  victoryStat: { width: '48%', alignItems: 'center', marginBottom: 16 },
  victoryStatValue: { fontSize: 24, fontWeight: '800' },
  victoryStatLabel: { fontSize: 12, marginTop: 2 },
});
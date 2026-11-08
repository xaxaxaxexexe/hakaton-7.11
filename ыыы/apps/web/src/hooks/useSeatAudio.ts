import { useCallback, useEffect, useRef, useState } from 'react';
import type { Hall, Seat } from '../lib/types';

interface SpeakerChannel {
  gain: GainNode;
  pan: StereoPannerNode;
  position: { x: number; y: number; z: number };
}
interface AudioGraph {
  context: AudioContext;
  oscillators: OscillatorNode[];
  channels: SpeakerChannel[];
  master: GainNode;
}

function moveListener(graph: AudioGraph, hall: Hall, seat: Seat) {
  const time = graph.context.currentTime;
  const eyeY = seat.position.y + hall.camera.eye_height;
  const facingAngle = Math.atan2(
    hall.screen.center.x - seat.position.x,
    seat.position.z - hall.screen.center.z,
  );
  for (const channel of graph.channels) {
    const dx = channel.position.x - seat.position.x;
    const dy = channel.position.y - eyeY;
    const dz = channel.position.z - seat.position.z;
    const distance = Math.hypot(dx, dy, dz);
    // Equal sources: the closer speaker is louder; rear rows attenuate naturally.
    const gain = Math.min(0.34, 1.7 / (2.8 + distance));
    channel.gain.gain.setTargetAtTime(gain, time, 0.14);
    const sourceAngle = Math.atan2(dx, -dz);
    const relativeAngle = Math.atan2(Math.sin(sourceAngle - facingAngle), Math.cos(sourceAngle - facingAngle));
    channel.pan.pan.setTargetAtTime(Math.max(-0.95, Math.min(0.95, Math.sin(relativeAngle))), time, 0.14);
  }
}

/** A quiet local synth; no network audio, autoplay or payment dependency. */
export function useSeatAudio(hall: Hall | null, seat: Seat | null) {
  const graphRef = useRef<AudioGraph | null>(null);
  const latestRef = useRef({ hall, seat });
  latestRef.current = { hall, seat };
  const mountedRef = useRef(true);
  const startingRef = useRef(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    const graph = graphRef.current;
    graphRef.current = null;
    startingRef.current = false;
    if (graph) {
      graph.master.gain.setValueAtTime(0, graph.context.currentTime);
      graph.oscillators.forEach((oscillator) => {
        try { oscillator.stop(); } catch { /* An already stopped source needs no work. */ }
        oscillator.disconnect();
      });
      void graph.context.close().catch(() => undefined);
    }
    if (mountedRef.current) setEnabled(false);
  }, []);

  const toggle = useCallback(() => {
    if (graphRef.current || startingRef.current) {
      stop();
      return;
    }
    const { hall: currentHall, seat: currentSeat } = latestRef.current;
    if (!currentHall || !currentSeat) return;
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) {
      setError('Этот браузер не поддерживает пространственный звук.');
      return;
    }
    startingRef.current = true;
    setError(null);
    let openingContext: AudioContext | null = null;
    try {
      const context = new AudioContextClass();
      openingContext = context;
      const master = context.createGain();
      master.gain.value = 0;
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -20;
      compressor.ratio.value = 8;
      master.connect(compressor);
      compressor.connect(context.destination);
      const bus = context.createGain();
      bus.gain.value = 0.16;
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1600;
      filter.Q.value = 0.3;
      filter.connect(bus);
      const frequencies = [110, 164.81, 220, 329.63];
      const oscillators = frequencies.map((frequency, index) => {
        const oscillator = context.createOscillator();
        oscillator.type = index === 0 ? 'triangle' : 'sine';
        oscillator.frequency.value = frequency;
        oscillator.detune.value = index % 2 ? 3 : -3;
        const voice = context.createGain();
        voice.gain.value = index === 0 ? 0.35 : 0.22;
        oscillator.connect(voice);
        voice.connect(filter);
        oscillator.start();
        return oscillator;
      });
      const speakers = currentHall.speakers.length ? currentHall.speakers : [{ id: 'screen', position: currentHall.screen.center }];
      const channels = speakers.map((speaker) => {
        const gain = context.createGain();
        const pan = context.createStereoPanner();
        gain.gain.value = 0;
        bus.connect(gain);
        gain.connect(pan);
        pan.connect(master);
        return { gain, pan, position: speaker.position };
      });
      const graph = { context, oscillators, channels, master };
      graphRef.current = graph;
      moveListener(graph, currentHall, currentSeat);
      // resume is called directly in the click/tap chain, as required by browser autoplay policies.
      void context.resume().then(() => {
        if (!mountedRef.current || graphRef.current !== graph) return;
        graph.master.gain.setTargetAtTime(0.65, context.currentTime, 0.15);
        startingRef.current = false;
        setEnabled(true);
      }).catch(() => {
        if (!mountedRef.current || graphRef.current !== graph) return;
        stop();
        setError('Не удалось включить звук. Попробуйте ещё раз.');
      });
    } catch {
      if (!graphRef.current && openingContext) void openingContext.close().catch(() => undefined);
      stop();
      setError('Не удалось включить звук на этом устройстве.');
    }
  }, [stop]);

  useEffect(() => {
    if (graphRef.current && hall && seat) moveListener(graphRef.current, hall, seat);
    if (!hall || !seat) stop();
  }, [hall, seat, stop]);

  useEffect(() => {
    mountedRef.current = true;
    const onVisibility = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [stop]);

  return { enabled, toggle, error };
}

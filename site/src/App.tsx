import { GoldWarden } from './components/GoldWarden';
import { AiLevels } from './sections/AiLevels';
import { DemoSlot } from './sections/DemoSlot';
import { Faq } from './sections/Faq';
import { Features } from './sections/Features';
import { Footer } from './sections/Footer';
import { Header } from './sections/Header';
import { Hero } from './sections/Hero';
import { OpenSource } from './sections/OpenSource';
import { Steps } from './sections/Steps';
import { WorksWith } from './sections/WorksWith';

export function App() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main" tabIndex={-1}>
        <Hero />
        <DemoSlot />
        <Features />
        <Steps />
        <AiLevels />
        <WorksWith />
        <OpenSource />
        <Faq />
      </main>
      <Footer />
      <GoldWarden />
    </>
  );
}

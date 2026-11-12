import { GoldWarden } from './components/GoldWarden';
import { DemoSlot } from './sections/DemoSlot';
import { Faq } from './sections/Faq';
import { Footer } from './sections/Footer';
import { Header } from './sections/Header';
import { Hero } from './sections/Hero';
import { HowItWorks } from './sections/HowItWorks';
import { OpenSource } from './sections/OpenSource';
import { Steps } from './sections/Steps';

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
        <HowItWorks />
        <Steps />
        <OpenSource />
        <Faq />
      </main>
      <Footer />
      <GoldWarden />
    </>
  );
}

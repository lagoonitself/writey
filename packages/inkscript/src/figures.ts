import { type DiagramItem, num, type Pt, pt, text } from './sketch'

// A library of textbook figures (biology first) drawn as line art, so Writey draws a
// recognisable heart or eye instead of the model inventing one. Each figure is SVG path
// data on a y-down canvas plus its parts, named at a point on each; a `figure` item
// expands into `svg` items and one `callouts` item, so the names line up like a textbook's.

export type FigurePart = { name: string; at: Pt; also?: string[] }

/** A path drawn as a tube: two walls `tube` apart (vessels, gut, tubules). */
export type FigureTube = { d: string; tube: number }

export type Figure = {
  title: string
  also: string[]
  paths: (string | FigureTube)[]
  parts: FigurePart[]
}

export const FIGURES: Record<string, Figure> = {
  heart: {
    title: 'Human heart (internal structure)',
    also: ['human heart', 'heart section', 'structure of heart', 'internal structure of heart'],
    paths: [
      // Outer wall, open where the vessels enter.
      'M52 92 C36 100 30 126 38 152 M56 170 C66 196 100 220 132 232 C160 214 186 182 182 144 M72 92 C82 94 90 96 98 100',
      // Superior and inferior vena cava.
      'M52 92 L52 10 M72 92 L72 10',
      'M38 152 L38 210 M56 170 L56 210',
      // Aorta: up, over the arch and down behind the pulmonary artery; three branches.
      'M98 100 C96 70 96 46 110 32 C126 18 152 18 164 34 C170 44 172 56 170 66',
      'M114 100 C112 76 112 58 122 48 C132 40 146 42 150 52 C153 58 153 64 152 69',
      'M104 38 L100 10 M113 30 L110 8 M122 24 L122 3 M131 22 L131 2 M147 23 L151 4 M156 27 L160 8',
      // Pulmonary artery, out to the lungs.
      'M118 100 C120 84 130 74 146 70 L198 62 M134 106 C138 94 146 88 160 85 L198 80',
      // Pulmonary veins into the left atrium.
      'M176 116 L200 110 M177 122 L200 120 M177 130 L200 132 M175 136 L200 142',
      // Right atrium, right ventricle, left atrium, left ventricle.
      'M72 102 C88 102 94 114 94 126 C94 140 86 148 72 148 C58 148 50 140 50 126 C50 112 58 102 72 102 Z',
      'M70 166 C78 160 96 160 104 166 C110 182 112 198 114 210 C100 204 86 194 76 184 C70 178 68 172 70 166 Z',
      'M150 108 C166 108 176 116 176 126 C176 136 166 142 150 142 C134 142 126 134 126 126 C126 116 134 108 150 108 Z',
      'M130 156 C140 150 160 150 170 156 C174 172 168 190 156 206 C148 214 138 214 134 206 C128 190 126 172 130 156 Z',
      // Tricuspid and bicuspid valves; semilunar valves at the base of the aorta.
      'M64 150 L70 163 M84 150 L80 163 M140 142 L146 153 M162 142 L158 153',
      'M98 100 Q106 106 114 100',
    ],
    parts: [
      { name: 'superior vena cava', at: [62, 40], also: ['vena cava'] },
      { name: 'aorta', at: [106, 64], also: ['aortic arch'] },
      { name: 'pulmonary artery', at: [186, 72], also: ['pulmonary trunk'] },
      { name: 'pulmonary veins', at: [192, 124], also: ['pulmonary vein'] },
      { name: 'right atrium', at: [72, 125] },
      { name: 'left atrium', at: [150, 125] },
      { name: 'semilunar valves', at: [106, 103], also: ['semilunar valve', 'aortic valve'] },
      { name: 'tricuspid valve', at: [74, 156] },
      { name: 'bicuspid valve', at: [151, 147], also: ['mitral valve'] },
      { name: 'right ventricle', at: [86, 185] },
      { name: 'left ventricle', at: [150, 182] },
      { name: 'septum', at: [120, 190], also: ['interventricular septum'] },
      { name: 'inferior vena cava', at: [47, 200] },
    ],
  },

  eye: {
    title: 'Human eye (section)',
    also: ['human eye', 'structure of eye', 'eye section', 'structure of human eye'],
    paths: [
      // Sclera, open at the front where the cornea sits.
      'M52 62 A70 70 0 1 1 52 138',
      // Choroid and retina inside it.
      'M60 50 A64 64 0 0 1 172 72 M172 128 A64 64 0 0 1 60 150 M172 72 A64 64 0 0 1 172 128',
      'M66 52 A58 58 0 0 1 166 76 M166 124 A58 58 0 0 1 66 148 M166 76 A58 58 0 0 1 166 124',
      // Cornea.
      'M52 62 C26 76 26 124 52 138',
      // Iris (two flaps), lens, suspensory ligaments and ciliary body.
      'M54 66 L60 90 M54 134 L60 110',
      'M70 78 C80 84 80 116 70 122 C60 116 60 84 70 78 Z',
      'M70 78 L64 60 M70 122 L64 140 M66 54 C60 56 60 62 64 64 M66 146 C60 144 60 138 64 136',
      // Optic nerve leaving the back, with the blind spot and the fovea.
      'M176 108 L204 116 M174 126 L202 134',
      'M166 96 Q170 100 166 104',
    ],
    parts: [
      { name: 'cornea', at: [33, 100] },
      { name: 'iris', at: [57, 72] },
      { name: 'pupil', at: [57, 100] },
      { name: 'aqueous humour', at: [45, 120], also: ['aqueous humor'] },
      { name: 'lens', at: [70, 100], also: ['eye lens', 'crystalline lens'] },
      { name: 'ciliary muscles', at: [64, 58], also: ['ciliary body', 'ciliary muscle'] },
      { name: 'suspensory ligaments', at: [67, 132], also: ['suspensory ligament'] },
      { name: 'vitreous humour', at: [120, 100], also: ['vitreous humor'] },
      { name: 'sclera', at: [130, 31] },
      { name: 'choroid', at: [150, 44] },
      { name: 'retina', at: [162, 62] },
      { name: 'yellow spot (fovea)', at: [167, 100], also: ['fovea', 'yellow spot'] },
      { name: 'blind spot', at: [172, 118] },
      { name: 'optic nerve', at: [196, 124] },
    ],
  },

  flower: {
    title: 'Flower (longitudinal section)',
    also: [
      'parts of a flower',
      'flower ls',
      'l.s. of flower',
      'structure of flower',
      'bisexual flower',
    ],
    paths: [
      // Pedicel and receptacle.
      'M96 204 C96 186 96 170 94 154 M104 204 C104 186 104 170 106 154',
      'M80 156 C88 146 112 146 120 156 C112 160 88 160 80 156 Z',
      // Ovary with ovules.
      'M100 150 C84 148 80 128 86 116 C90 108 96 104 100 104 C104 104 110 108 114 116 C120 128 116 148 100 150 Z',
      'M95 120 a3 3 0 1 0 0.1 0 M95 132 a3 3 0 1 0 0.1 0 M105 126 a3 3 0 1 0 0.1 0 M105 138 a3 3 0 1 0 0.1 0',
      'M100 112 L100 144',
      // Style and stigma.
      'M97 105 C96 90 96 74 97 60 M103 105 C104 90 104 74 103 60',
      'M90 60 C90 50 110 50 110 60 C104 64 96 64 90 60 Z',
      // Sepals.
      'M82 156 C66 158 50 150 42 134 C58 136 72 142 84 150',
      'M118 156 C134 158 150 150 158 134 C142 136 128 142 116 150',
      // Petals.
      'M84 150 C60 140 34 110 30 64 C52 76 72 102 88 140',
      'M116 150 C140 140 166 110 170 64 C148 76 128 102 112 140',
      // Stamens: filaments and anthers.
      'M88 148 C78 128 70 104 66 80 M112 148 C122 128 130 104 134 80',
      'M66 80 C58 78 56 64 62 60 C70 58 74 70 72 78 C70 80 68 80 66 80 Z',
      'M134 80 C142 78 144 64 138 60 C130 58 126 70 128 78 C130 80 132 80 134 80 Z',
    ],
    parts: [
      { name: 'stigma', at: [100, 54] },
      { name: 'style', at: [100, 80] },
      { name: 'ovary', at: [112, 120] },
      { name: 'ovule', at: [95, 132], also: ['ovules'] },
      { name: 'anther', at: [64, 68] },
      { name: 'filament', at: [126, 110] },
      { name: 'petal', at: [40, 82], also: ['petals', 'corolla'] },
      { name: 'sepal', at: [150, 142], also: ['sepals', 'calyx'] },
      { name: 'receptacle', at: [84, 156], also: ['thalamus'] },
      { name: 'pedicel', at: [104, 190], also: ['stalk'] },
    ],
  },

  digestive_system: {
    title: 'Human digestive system',
    also: ['digestive system', 'alimentary canal', 'human alimentary canal', 'digestive tract'],
    paths: [
      // Mouth and salivary glands.
      'M86 14 C94 6 108 6 116 14 C108 22 94 22 86 14 Z',
      'M62 18 C62 11 76 11 76 18 C76 25 62 25 62 18 Z M126 18 C126 11 140 11 140 18 C140 25 126 25 126 18 Z M76 18 L86 14 M126 18 L116 14',
      { d: 'M101 22 L102 92', tube: 9 },
      // Liver and gall bladder.
      'M30 104 C36 88 66 82 94 88 C98 98 96 114 88 124 C78 136 54 140 40 134 C30 128 28 116 30 104 Z',
      'M70 136 C68 148 80 152 84 142 C86 138 84 134 80 134',
      // Stomach.
      'M97 92 C104 82 120 82 128 86 C150 92 166 108 164 132 C162 154 140 168 114 166 C104 165 96 160 96 152 C96 144 104 142 112 144 C124 146 134 140 134 128 C134 116 122 108 110 108 C102 108 97 102 97 92 Z',
      { d: 'M97 156 C82 162 82 176 92 180 C100 183 112 180 122 176', tube: 7 },
      // Pancreas.
      'M108 172 C120 166 144 166 158 172 C152 180 128 182 108 172 Z',
      // Large intestine: caecum and appendix, colon, rectum.
      {
        d: 'M60 272 L60 198 C60 193 64 190 70 190 L150 190 C156 190 160 193 160 198 L160 254 C160 264 150 268 136 268 L108 268 L108 300',
        tube: 12,
      },
      'M54 272 C54 282 66 282 66 272',
      { d: 'M58 280 C56 290 52 296 47 294', tube: 3 },
      // Small intestine, coiled.
      {
        d: 'M124 206 C142 208 146 218 132 222 C116 226 92 216 82 226 C74 234 90 242 108 238 C126 234 146 240 140 250 C134 258 104 258 84 254 C76 253 70 256 66 262',
        tube: 6,
      },
    ],
    parts: [
      { name: 'mouth', at: [101, 14], also: ['buccal cavity', 'oral cavity'] },
      { name: 'salivary glands', at: [69, 18], also: ['salivary gland'] },
      { name: 'oesophagus', at: [101, 50], also: ['esophagus', 'food pipe', 'gullet'] },
      { name: 'liver', at: [56, 110] },
      { name: 'gall bladder', at: [76, 144], also: ['gallbladder'] },
      { name: 'stomach', at: [150, 128] },
      { name: 'duodenum', at: [84, 172] },
      { name: 'pancreas', at: [140, 174] },
      { name: 'large intestine', at: [110, 190], also: ['colon', 'transverse colon'] },
      { name: 'small intestine', at: [100, 238], also: ['ileum'] },
      { name: 'caecum', at: [60, 270], also: ['cecum'] },
      { name: 'appendix', at: [49, 294], also: ['vermiform appendix'] },
      { name: 'rectum', at: [108, 284] },
      { name: 'anus', at: [108, 300] },
    ],
  },

  respiratory_system: {
    title: 'Human respiratory system',
    also: ['respiratory system', 'lungs', 'human lungs', 'breathing system', 'respiratory tract'],
    paths: [
      // Larynx and trachea with its cartilage rings.
      'M92 14 L108 14 L106 28 L94 28 Z',
      { d: 'M100 28 L100 108', tube: 12 },
      'M94 40 L106 40 M94 52 L106 52 M94 64 L106 64 M94 76 L106 76 M94 88 L106 88 M94 100 L106 100',
      // Bronchi and bronchioles.
      { d: 'M100 108 C92 118 80 126 66 138', tube: 8 },
      { d: 'M100 108 C108 118 120 126 134 138', tube: 8 },
      'M66 138 L54 150 L46 166 M54 150 L58 170 M66 138 L70 158 L64 178 M70 158 L78 176',
      'M134 138 L146 150 L154 166 M146 150 L142 170 M134 138 L130 158 L136 178 M130 158 L122 176',
      // Alveoli at the end of a bronchiole.
      'M154 166 C150 170 152 176 156 176 C156 182 164 182 164 176 C170 176 170 168 164 168 C162 162 154 162 154 166 Z',
      // Lungs, their lobes, and the diaphragm.
      'M88 48 C64 48 34 88 30 150 C28 186 40 200 62 198 C78 196 88 190 90 182 L90 116',
      'M112 48 C136 48 166 88 170 150 C172 186 160 200 138 198 C126 196 116 190 116 184 C120 176 122 168 114 160 L110 116',
      'M36 118 C54 114 72 108 88 98 M32 160 C52 154 72 150 90 150 M164 126 C146 122 128 114 112 100',
      'M14 212 C50 194 150 194 186 212',
    ],
    parts: [
      { name: 'larynx', at: [100, 21], also: ['voice box'] },
      { name: 'trachea', at: [100, 70], also: ['windpipe'] },
      { name: 'cartilage rings', at: [94, 46], also: ['cartilage ring', 'c-shaped rings'] },
      { name: 'bronchus', at: [78, 128], also: ['bronchi', 'primary bronchus'] },
      { name: 'bronchioles', at: [54, 152], also: ['bronchiole'] },
      { name: 'alveoli', at: [160, 172], also: ['alveolus', 'air sacs'] },
      { name: 'right lung', at: [48, 96] },
      { name: 'left lung', at: [152, 96] },
      { name: 'diaphragm', at: [140, 199] },
    ],
  },

  animal_cell: {
    title: 'Animal cell',
    also: ['animal cell structure', 'typical animal cell', 'cell', 'eukaryotic cell'],
    paths: [
      'M100 8 C150 6 196 40 194 84 C192 130 150 156 100 154 C48 152 6 126 6 80 C6 36 50 10 100 8 Z',
      // Nucleus: double membrane, nucleolus.
      'M72 80 A28 26 0 1 1 128 80 A28 26 0 1 1 72 80 Z M77 80 A23 21 0 1 1 123 80 A23 21 0 1 1 77 80 Z',
      'M93 84 A7 6 0 1 1 107 84 A7 6 0 1 1 93 84 Z',
      // Mitochondria with cristae.
      'M136 42 C140 32 162 34 166 44 C168 54 146 60 138 54 C134 50 134 46 136 42 Z M140 47 L144 39 L148 53 L152 38 L156 54 L160 40 L163 49',
      'M34 116 C38 106 60 108 62 118 C64 128 42 132 36 126 C32 122 32 120 34 116 Z M38 120 L42 112 L46 126 L50 111 L54 127 L58 114 L60 122',
      // Rough endoplasmic reticulum with ribosomes.
      'M132 98 q8 -7 16 0 q8 7 16 0 M130 107 q8 -7 16 0 q8 7 16 0 M128 116 q8 -7 16 0 q8 7 16 0',
      'M134 95 a1.4 1.4 0 1 0 0.1 0 M150 103 a1.4 1.4 0 1 0 0.1 0 M162 95 a1.4 1.4 0 1 0 0.1 0 M140 112 a1.4 1.4 0 1 0 0.1 0 M156 120 a1.4 1.4 0 1 0 0.1 0',
      // Golgi apparatus with vesicles.
      'M28 54 Q45 45 62 54 M28 60 Q45 51 62 60 M29 66 Q45 57 61 66 M31 72 Q45 63 59 72',
      'M64 48 a2.5 2.5 0 1 0 0.1 0 M66 70 a2.5 2.5 0 1 0 0.1 0',
      // Lysosome, vacuole, centrioles, free ribosomes.
      'M72 132 A6 6 0 1 1 84 132 A6 6 0 1 1 72 132 Z',
      'M140 132 C140 122 160 120 162 128 C164 138 146 142 140 132 Z',
      'M92 34 L102 34 L102 38 L92 38 Z M108 28 L112 28 L112 38 L108 38 Z',
      'M56 92 a1.4 1.4 0 1 0 0.1 0 M172 76 a1.4 1.4 0 1 0 0.1 0 M116 136 a1.4 1.4 0 1 0 0.1 0 M50 40 a1.4 1.4 0 1 0 0.1 0',
    ],
    parts: [
      { name: 'cell membrane', at: [100, 8], also: ['plasma membrane'] },
      { name: 'nucleus', at: [116, 64], also: ['nuclear membrane'] },
      { name: 'nucleolus', at: [100, 84] },
      { name: 'mitochondrion', at: [151, 46], also: ['mitochondria'] },
      {
        name: 'endoplasmic reticulum',
        at: [156, 107],
        also: ['rough endoplasmic reticulum', 'er'],
      },
      { name: 'ribosomes', at: [56, 93], also: ['ribosome'] },
      { name: 'Golgi apparatus', at: [45, 60], also: ['golgi body', 'golgi complex'] },
      { name: 'lysosome', at: [78, 132], also: ['lysosomes'] },
      { name: 'vacuole', at: [151, 131] },
      { name: 'centrioles', at: [102, 33], also: ['centriole', 'centrosome'] },
      { name: 'cytoplasm', at: [30, 90] },
    ],
  },

  plant_cell: {
    title: 'Plant cell',
    also: ['plant cell structure', 'typical plant cell'],
    paths: [
      // Cell wall and cell membrane.
      'M16 8 L184 8 Q192 8 192 16 L192 144 Q192 152 184 152 L16 152 Q8 152 8 144 L8 16 Q8 8 16 8 Z',
      'M21 14 L179 14 Q186 14 186 21 L186 139 Q186 146 179 146 L21 146 Q14 146 14 139 L14 21 Q14 14 21 14 Z',
      // Large central vacuole.
      'M62 38 C90 28 140 30 150 46 C160 66 158 108 140 118 C116 128 76 126 62 112 C50 98 48 50 62 38 Z',
      // Nucleus and nucleolus.
      'M20 42 A15 14 0 1 1 50 42 A15 14 0 1 1 20 42 Z M30 43 A5 4 0 1 1 40 43 A5 4 0 1 1 30 43 Z',
      // Chloroplasts with grana.
      'M160 60 A11 6 0 1 1 182 60 A11 6 0 1 1 160 60 Z M165 58 L169 58 M165 62 L169 62 M173 58 L177 58 M173 62 L177 62',
      'M160 112 A11 6 0 1 1 182 112 A11 6 0 1 1 160 112 Z M165 110 L169 110 M165 114 L169 114 M173 110 L177 110 M173 114 L177 114',
      'M24 96 A11 6 0 1 1 46 96 A11 6 0 1 1 24 96 Z M29 94 L33 94 M29 98 L33 98 M37 94 L41 94 M37 98 L41 98',
      'M88 136 A11 6 0 1 1 110 136 A11 6 0 1 1 88 136 Z M93 134 L97 134 M93 138 L97 138 M101 134 L105 134 M101 138 L105 138',
      // Mitochondrion.
      'M30 126 C33 118 50 119 52 127 C54 135 36 138 31 133 C28 130 28 128 30 126 Z M33 129 L37 122 L41 134 L45 121 L49 132',
      // Cytoplasm specks.
      'M160 84 a1.4 1.4 0 1 0 0.1 0 M130 140 a1.4 1.4 0 1 0 0.1 0 M60 24 a1.4 1.4 0 1 0 0.1 0',
    ],
    parts: [
      { name: 'cell wall', at: [100, 8] },
      { name: 'cell membrane', at: [186, 30], also: ['plasma membrane'] },
      { name: 'vacuole', at: [104, 78], also: ['central vacuole', 'large vacuole', 'tonoplast'] },
      { name: 'nucleus', at: [24, 36] },
      { name: 'nucleolus', at: [35, 43] },
      { name: 'chloroplast', at: [171, 60], also: ['chloroplasts'] },
      { name: 'mitochondrion', at: [40, 127], also: ['mitochondria'] },
      { name: 'cytoplasm', at: [160, 86] },
    ],
  },

  neuron: {
    title: 'Neuron (nerve cell)',
    also: ['nerve cell', 'structure of neuron', 'neurone', 'motor neuron'],
    paths: [
      // Cell body (cyton) with its nucleus.
      'M30 50 C30 34 44 28 54 34 C62 38 66 46 64 54 C62 64 50 70 40 66 C32 62 30 56 30 50 Z',
      'M42 50 A6 6 0 1 1 54 50 A6 6 0 1 1 42 50 Z',
      // Dendrites.
      'M34 38 L20 22 L10 18 M20 22 L18 10 M32 60 L18 76 L6 78 M18 76 L16 88 M44 30 L42 14 L34 6 M42 14 L50 6 M50 68 L52 84 L46 94 M52 84 L60 92 M30 48 L12 46 L4 40 M12 46 L4 52',
      // Axon in its myelin sheath, broken at the nodes of Ranvier.
      'M64 47 L196 47 M64 53 L196 53',
      'M76 42 L98 42 A4 8 0 0 1 98 58 L76 58 A4 8 0 0 1 76 42 Z M106 42 L128 42 A4 8 0 0 1 128 58 L106 58 A4 8 0 0 1 106 42 Z M136 42 L158 42 A4 8 0 0 1 158 58 L136 58 A4 8 0 0 1 136 42 Z M166 42 L188 42 A4 8 0 0 1 188 58 L166 58 A4 8 0 0 1 166 42 Z',
      // Axon terminals and synaptic knobs.
      'M196 47 L206 38 L214 34 M196 50 L210 50 L218 50 M196 53 L206 62 L214 66',
      'M214 34 a2.5 2.5 0 1 0 0.1 0 M218 50 a2.5 2.5 0 1 0 0.1 0 M214 66 a2.5 2.5 0 1 0 0.1 0',
    ],
    parts: [
      { name: 'dendrites', at: [20, 22], also: ['dendrite', 'dendron'] },
      { name: 'cell body', at: [36, 40], also: ['cyton', 'soma'] },
      { name: 'nucleus', at: [48, 50] },
      { name: 'axon', at: [70, 50] },
      { name: 'myelin sheath', at: [117, 42] },
      { name: 'node of Ranvier', at: [102, 50], also: ['nodes of ranvier'] },
      { name: 'axon terminals', at: [206, 38], also: ['axon terminal', 'nerve endings'] },
      { name: 'synaptic knob', at: [218, 50], also: ['synaptic knobs', 'synapse'] },
    ],
  },

  nephron: {
    title: 'Nephron',
    also: ['structure of nephron', 'kidney tubule', 'uriniferous tubule'],
    paths: [
      // Bowman's capsule around the glomerulus, with its arterioles.
      'M40 22 C60 14 80 30 76 50 C72 66 50 70 38 62 M44 30 C58 24 70 36 66 50 C62 60 50 62 42 56',
      'M44 42 C48 34 56 38 52 44 C48 50 56 56 60 50 C64 44 56 38 60 36 C64 34 66 44 62 48',
      { d: 'M10 34 L44 40', tube: 6 },
      { d: 'M42 52 L10 60', tube: 5 },
      // Proximal tubule, loop of Henle, distal tubule, collecting duct.
      {
        d: 'M76 44 C100 34 112 58 94 66 C78 72 86 92 104 86 C122 80 126 100 112 108 C104 112 104 120 112 126 L112 200 C112 216 134 216 134 200 L134 124 C136 104 152 96 162 102 C172 110 168 122 158 120 C150 118 152 106 162 100 C170 96 178 94 184 92',
        tube: 7,
      },
      { d: 'M184 14 L184 236', tube: 10 },
    ],
    parts: [
      { name: "Bowman's capsule", at: [72, 32], also: ['bowmans capsule', 'renal capsule'] },
      { name: 'glomerulus', at: [54, 44] },
      { name: 'afferent arteriole', at: [16, 35] },
      { name: 'efferent arteriole', at: [16, 59] },
      { name: 'proximal convoluted tubule', at: [100, 62], also: ['pct', 'proximal tubule'] },
      { name: 'loop of Henle', at: [123, 212], also: ['henles loop', 'loop of henle'] },
      { name: 'distal convoluted tubule', at: [164, 112], also: ['dct', 'distal tubule'] },
      { name: 'collecting duct', at: [184, 200] },
    ],
  },

  brain: {
    title: 'Human brain (sagittal section)',
    also: ['human brain', 'brain section', 'structure of brain', 'sagittal section of brain'],
    paths: [
      // Cerebrum with its folds.
      'M30 112 C12 80 30 30 82 18 C132 6 192 24 206 70 C212 98 200 118 178 124 M30 112 C42 124 72 124 92 116',
      'M58 40 Q66 52 58 62 M90 26 Q98 40 88 50 M124 24 Q118 38 128 48 M158 34 Q150 46 160 56 M184 54 Q174 62 182 74 M40 78 Q52 82 50 94',
      // Corpus callosum, thalamus, hypothalamus and pituitary.
      { d: 'M66 96 C84 74 140 70 166 90', tube: 6 },
      'M106 102 C106 94 134 92 136 102 C136 110 108 112 106 102 Z',
      'M94 108 C96 104 104 104 106 110 C104 116 96 116 94 108 Z',
      'M98 116 L96 124 M90 126 C88 133 102 135 102 128 C102 124 92 122 90 126 Z',
      // Brain stem (midbrain, pons, medulla) and spinal cord.
      'M118 112 C104 122 104 146 118 152 C116 162 118 172 120 186 M140 112 C140 130 138 150 136 160 C136 168 136 176 136 186',
      'M118 120 L140 118 M118 152 L137 152',
      // Cerebellum with the arbor vitae.
      'M142 128 C152 118 192 118 202 132 C208 146 192 162 168 162 C152 162 142 152 142 140',
      'M146 140 L172 136 L194 130 M172 136 L188 146 M158 138 L164 128 M180 133 L186 124',
    ],
    parts: [
      { name: 'cerebrum', at: [140, 38], also: ['cerebral hemisphere', 'cerebral cortex'] },
      { name: 'corpus callosum', at: [86, 84] },
      { name: 'thalamus', at: [121, 102] },
      { name: 'hypothalamus', at: [100, 110] },
      { name: 'pituitary gland', at: [95, 129], also: ['pituitary'] },
      { name: 'midbrain', at: [129, 116], also: ['mid brain'] },
      { name: 'pons', at: [112, 136], also: ['pons varolii'] },
      { name: 'medulla oblongata', at: [127, 168], also: ['medulla'] },
      { name: 'spinal cord', at: [128, 184] },
      { name: 'cerebellum', at: [184, 150] },
    ],
  },

  ear: {
    title: 'Human ear',
    also: ['human ear', 'structure of ear', 'ear section'],
    paths: [
      // Pinna and the ear canal.
      'M34 18 C12 22 6 60 14 86 C20 106 36 114 42 100 C46 90 34 86 34 76 M34 18 C46 18 50 34 44 50 C40 58 38 62 38 64',
      { d: 'M38 70 L100 72', tube: 12 },
      // Tympanic membrane, middle ear and the ossicles.
      'M98 58 L104 86',
      'M104 54 C120 46 140 48 146 58 L146 92 C140 100 120 100 104 90',
      'M103 70 L113 62 C117 58 121 60 119 64 L111 71',
      'M120 62 C126 58 132 62 130 68 L126 76',
      'M126 76 L136 76 M136 70 L136 82 M128 72 L136 70 M128 80 L136 82',
      // Semicircular canals, cochlea, auditory nerve, Eustachian tube.
      {
        d: 'M146 62 C138 42 150 26 164 30 C176 34 176 50 164 56 M156 60 C152 46 168 40 176 48 C184 56 178 68 168 66',
        tube: 4,
      },
      'M168 92 A4 4 0 1 1 176 92 A8 8 0 1 1 160 92 A12 12 0 1 1 184 92 A16 16 0 1 1 152 92',
      { d: 'M186 80 L214 70', tube: 6 },
      { d: 'M132 98 C136 116 150 128 168 136', tube: 7 },
    ],
    parts: [
      { name: 'pinna', at: [16, 50], also: ['auricle', 'outer ear'] },
      { name: 'ear canal', at: [62, 71], also: ['external auditory canal', 'auditory canal'] },
      { name: 'tympanic membrane', at: [101, 66], also: ['eardrum', 'ear drum'] },
      { name: 'malleus', at: [113, 63], also: ['hammer'] },
      { name: 'incus', at: [127, 63], also: ['anvil'] },
      { name: 'stapes', at: [136, 76], also: ['stirrup'] },
      { name: 'semicircular canals', at: [164, 30], also: ['semicircular canal'] },
      { name: 'cochlea', at: [168, 104] },
      { name: 'auditory nerve', at: [206, 73], also: ['cochlear nerve'] },
      { name: 'Eustachian tube', at: [152, 126], also: ['eustachian tube'] },
    ],
  },
}

/** Words that mark a part group rather than a name ("stamen" → anther + filament). */
const GROUPS: Record<string, string[]> = {
  stamen: ['anther', 'filament'],
  pistil: ['stigma', 'style', 'ovary'],
  carpel: ['stigma', 'style', 'ovary'],
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .replace(/\b(the|of|a|an|human|diagram|labelled|labeled)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** The figure a name asks for ("human heart", "L.S. of flower"), or null. */
export function findFigure(name: string): Figure | null {
  const n = norm(name)
  if (!n) return null
  for (const [key, f] of Object.entries(FIGURES)) {
    if (norm(key) === n || f.also.some((a) => norm(a) === n)) return f
  }
  // Every word of the key in the name, so "eye section" and "the human eye" both work.
  for (const [key, f] of Object.entries(FIGURES)) {
    const words = norm(key).split(' ')
    if (words.every((w) => n.split(' ').includes(w))) return f
  }
  return null
}

export const FIGURE_NAMES = Object.keys(FIGURES)

function pickParts(f: Figure, want: unknown): FigurePart[] {
  if (want === false || want === 'none') return []
  if (!Array.isArray(want)) return f.parts
  const names = want.filter((w): w is string => typeof w === 'string').map(norm)
  const wanted = new Set(names.flatMap((n) => GROUPS[n] ?? [n]))
  return f.parts.filter((p) => [p.name, ...(p.also ?? [])].some((a) => wanted.has(norm(a))))
}

/**
 * A `figure` item as drawable items: its paths, placed by `at` and `scale`, and one
 * callouts item with the parts asked for (`labels`: names, or false; all by default),
 * plus any `extra` callouts the model adds in the figure's own units.
 */
export function expandFigure(o: DiagramItem): DiagramItem[] | null {
  const f = findFigure(
    text(o, 'name') || text(o, 'figure') || text(o, 'of') || text(o, 'type') || text(o),
  )
  if (!f) return null
  const scale = num(o.scale, 1)
  const at = pt(o.at) ?? [0, 0]
  const place = (p: Pt): Pt => [at[0] + p[0] * scale, at[1] + p[1] * scale]
  const labels = pickParts(f, o.labels ?? o.parts).map((p) => ({ at: place(p.at), text: p.name }))
  const extra = Array.isArray(o.extra) ? o.extra : []
  for (const e of extra) {
    const v = (e ?? {}) as Record<string, unknown>
    const p = pt(v.at)
    if (p && typeof v.text === 'string') labels.push({ at: place(p), text: v.text })
  }
  const out: DiagramItem[] = []
  for (const p of f.paths) {
    const last = out.at(-1)
    if (typeof p !== 'string') out.push({ kind: 'svg', d: p.d, tube: p.tube, at, scale })
    else if (last && !last.tube) (last.paths as string[]).push(p)
    else out.push({ kind: 'svg', paths: [p], at, scale })
  }
  if (labels.length) out.push({ kind: 'callouts', labels })
  return out
}

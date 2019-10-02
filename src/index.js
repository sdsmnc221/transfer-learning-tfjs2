// Tweaked from:
// https://github.com/tensorflow/tfjs-examples/blob/master/webcam-transfer-learning/index.js


import './styles.scss';

import * as tf from '@tensorflow/tfjs';
import Dataset from './Dataset';

const NUM_CLASSES = 2;
const CLASS_LABEL = 0; //PIANO
const IS_PIANO_WHEN = 0.8;
const IMAGE_SIZE = 224;

//TRAIN CONFIGS, for now const value
const DENSE_UNITS = 100;
const LEARNING_RATE = 0.0001;
const EPOCHS = 20;
const BATCH_SIZE_FRACTION = 0.4;

class App {
    constructor(container) {
        this.container = document.querySelector(container);
        this.bind();
        this.init();
    }

    bind() {
        this.add = this.add.bind(this);
        this.test = this.test.bind(this);
        this.train = this.train.bind(this);
        this.predict = this.predict.bind(this);
    }

    init() {
        this.isPredicting = false;
        this.model = null;
        // The dataset object where we will store activations.
        this.dataset = new Dataset(NUM_CLASSES);

        Promise.all([this.loadModel(), this.loadWebcam(), this.loadButtons(), this.loadStt()])
            .then(async () => {
                // Warm up the model. This uploads weights to the GPU and compiles the WebGL
                // programs so the first time we collect data from the webcam it will be
                // quick.
                this.screenshot = await this.webcam.capture();
                this.mobilenet.predict(this.screenshot.expandDims(0));
                this.screenshot.dispose();
            })
    }

    async loadWebcam() {
        this.webcamStt = document.createElement('p');
        this.webcamStt.innerHTML = 'Waiting for webcam...';
        this.container.append(this.webcamStt);

        this.video = document.createElement('video');
        this.video.setAttribute('autoplay', '');
        this.video.setAttribute('playsinline', '');
        this.video.setAttribute('muted', '');
        this.video.width = IMAGE_SIZE;
        this.video.height = IMAGE_SIZE;
        this.container.append(this.video);

        try {
            this.webcam = await tf.data.webcam(this.video);
            this.webcamStt.innerHTML = 'Webcam ready!'
        } catch (e) {
            console.log(e);
        }
    }

    loadButtons() {
        this.buttonsDisabled = true;
        this.buttons = {
            test: document.createElement('button'),
            add: document.createElement('button'),
            train: document.createElement('button'),
            predict: document.createElement('button')
        }

        const {
            test,
            add,
            train,
            predict
        } = this.buttons;

        test.innerHTML = 'Add test (class 2)...';
        test.addEventListener('click', this.test)

        add.innerHTML = 'Add your piano example to train!';
        add.addEventListener('click', this.add)

        train.innerHTML = 'Train your piano!';
        train.addEventListener('click', this.train);

        predict.innerHTML = 'Start predicting!';
        predict.addEventListener('click', this.predict);

        Object.values(this.buttons).forEach(b => {
            b.setAttribute('disabled', '');
            this.container.append(b);
        })
    }

    loadStt() {
        this.isPiano = false;
        this.count = {
            test: 0,
            examples: 0,
            loss: 0,
            confidence: 0,
        }

        this.stt = {
            test: document.createElement('p'),
            add: document.createElement('p'),
            train: document.createElement('p'),
            predict: document.createElement('p')
        }

        const {
            test,
            add,
            train,
            predict
        } = this.stt;

        test.innerHTML = 'No example (test) added.';
        add.innerHTML = 'No example added.';
        train.innerHTML = 'Not yet trained.';
        predict.innerHTML = 'No prediction yet.';

        Object.values(this.stt).forEach(s => this.container.append(s))
    }

    // Loads mobilenet and returns a model that returns 
    // the internal activation that will be used as inputs
    // to the classifier model.
    async loadModel() {
        this.mobilenetStt = document.createElement('p');
        this.mobilenetStt.innerHTML = 'Loading model...';
        this.container.append(this.mobilenetStt);

        // not loading from @tensorflow-models/mobilenet because of
        // API differences and slower loading
        const model = await tf.loadLayersModel(
            'https://storage.googleapis.com/tfjs-models/tfjs/mobilenet_v1_0.25_224/model.json');
        const layer = model.getLayer(('conv_pw_13_relu'));
        this.mobilenet = tf.model({
            inputs: model.inputs,
            outputs: layer.output
        });
        this.mobilenetStt.innerHTML = 'Model ready!';
        this.toggleButtons();
    }

    async add() {
        this.screenshot = await this.snapshot();
        this.dataset.addExample(this.mobilenet.predict(this.screenshot), CLASS_LABEL);

        this.count.examples++;
        this.stt.add.innerHTML = `Added ${this.count.examples} example(s).`;
    }

    async test() {
        this.screenshot = await this.snapshot();
        this.dataset.addExample(this.mobilenet.predict(this.screenshot), 1);

        this.count.test++;
        this.stt.test.innerHTML = `Added ${this.count.test} example(s).`;
    }

    /**
     * Captures a frame from the webcam and normalizes it between -1 and 1.
     * Returns a batched image (1-element batch) of shape [1, w, h, c].
     */
    async snapshot() {
        const img = await this.webcam.capture();
        const processedImg =
            tf.tidy(() => img.expandDims(0).toFloat().div(127).sub(1));
        img.dispose();
        return processedImg;
    }

    // Setup & train the classifier
    async train() {
        this.isPredicting = false;

        if (this.dataset.xs == null) {
            throw new Error('Add some examples before training!');
        }

        // Creates a 2-layer fully connected model. By creating a separate model,
        // rather than adding layers to the mobilenet model, we "freeze" the weights
        // of the mobilenet model, and only train weights from the new model.
        this.model = tf.sequential({
            layers: [
                // Flattens the input to a vector so we can use it in a dense layer. While
                // technically a layer, this only performs a reshape (and has no training
                // parameters).
                tf.layers.flatten({
                    inputShape: this.mobilenet.outputs[0].shape.slice(1)
                }),
                // Layer 1.
                tf.layers.dense({
                    units: DENSE_UNITS,
                    activation: 'relu',
                    kernelInitializer: 'varianceScaling',
                    useBias: true
                }),
                // Layer 2. The number of units of the last layer should correspond
                // to the number of classes we want to predict.
                tf.layers.dense({
                    units: NUM_CLASSES,
                    kernelInitializer: 'varianceScaling',
                    useBias: false,
                    activation: 'softmax'
                })
            ]
        });

        // Creates the optimizers which drives training of the model.
        const optimizer = tf.train.adam(LEARNING_RATE);
        // We use categoricalCrossentropy which is the loss function we use for
        // categorical classification which measures the error between our predicted
        // probability distribution over classes (probability that an input is of each
        // class), versus the label (100% probability in the true class)>
        this.model.compile({
            optimizer: optimizer,
            loss: 'categoricalCrossentropy'
        });

        // We parameterize batch size as a fraction of the entire dataset because the
        // number of examples that are collected depends on how many examples the user
        // collects. This allows us to have a flexible batch size.
        const batchSize =
            Math.floor(this.dataset.xs.shape[0] * BATCH_SIZE_FRACTION);
        if (!(batchSize > 0)) {
            throw new Error(
                `Batch size is 0 or NaN. Please choose a non-zero fraction.`);
        }

        // Train the model! Model.fit() will shuffle xs & ys so we don't have to.
        this.model.fit(this.dataset.xs, this.dataset.ys, {
            batchSize,
            epochs: EPOCHS,
            callbacks: {
                onBatchEnd: async (batch, logs) => {
                    this.stt.train.innerHTML = `Loss: ${logs.loss.toFixed(5)}.`;
                }
            }
        });
    }

    async predict() {
        this.isPredicting = true;

        while (this.isPredicting) {
            // Capture the frame from the webcam.
            this.screenshot = await this.snapshot();

            // Make a prediction through mobilenet, getting the internal activation of
            // the mobilenet model, i.e., "embeddings" of the input images.
            const embeddings = this.mobilenet.predict(this.screenshot);

            // Make a prediction through our newly-trained model using the embeddings
            // from mobilenet as input.
            const predictions = this.model.predict(embeddings);

            // Returns the index with the maximum probability. This number corresponds
            // to the class the model thinks is the most probable given the input.
            // const predictedClass = predictions.as1D().argMax();
            // const classId = (await predictedClass.data())[0];

            // Returns the first index (confidence value) and check if >= IS_PIANO_WHEN
            console.log(predictions.dataSync());
            const confidence = await predictions.dataSync()[0];
            this.isPiano = confidence >= IS_PIANO_WHEN;
            this.count.confidence = this.isPiano ? confidence : 1 - confidence;

            // this.stt.predict.innerHTML = `This is class ${classId}: ${classId === 0 ? 'PIANO' : 'TEST/NOT PIANO'}.`;
            this.stt.predict.innerHTML = `This is ${!this.isPiano ? 'not' : ''} a piano with ${this.count.confidence * 100}% confidence.`;

            this.screenshot.dispose();
            await tf.nextFrame();
        }
    }

    toggleButtons() {
        this.buttonsDisabled = !this.buttonsDisabled;
        Object.values(this.buttons).forEach(b => {
            if (this.buttonsDisabled) {
                b.setAttribute('disabled', '');
            } else {
                b.removeAttribute('disabled');
            }
        })
    }

}

window.onload = () => (window.app = new App('#app'));
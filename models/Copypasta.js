import mongoose from "mongoose";

const copypastaSchema = new mongoose.Schema({
    text: {type: String, required: true}
});

const Copypasta = mongoose.model("Copypasta", copypastaSchema);

export default Copypasta;